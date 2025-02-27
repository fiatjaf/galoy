import { once } from "events"
import { sleep } from "@core/utils"
import { filter, first } from "lodash"
import { baseLogger } from "@services/logger"
import {
  getFeeRates,
  getUserLimits,
  MS_PER_DAY,
  getOnChainWalletConfig,
} from "@config/app"
import { Transaction } from "@services/mongoose/schema"
import { getTitle } from "@services/notifications/payment"
import { onchainTransactionEventHandler } from "@servers/trigger"
import {
  checkIsBalanced,
  getUserWallet,
  lndonchain,
  lndOutside1,
  createChainAddress,
  subscribeToTransactions,
  bitcoindClient,
  bitcoindOutside,
  mineBlockAndSync,
  enable2FA,
  generateTokenHelper,
  RANDOM_ADDRESS,
  mineBlockAndSyncAll,
} from "test/helpers"
import { ledger } from "@services/mongodb"
import { PaymentInitiationMethod, TxStatus } from "@domain/wallets"
import * as Wallets from "@app/wallets"
import { TwoFAError, TransactionRestrictedError } from "@core/error"
import { getBTCBalance, getRemainingTwoFALimit } from "test/helpers/wallet"
import { NotificationType } from "@domain/notifications"
import { toTargetConfs } from "@domain/bitcoin"

jest.mock("@services/phone-provider", () => require("test/mocks/phone-provider"))
jest.mock("@services/notifications/notification")

const date = Date.now() + 1000 * 60 * 60 * 24 * 8

jest.spyOn(global.Date, "now").mockImplementation(() => new Date(date).valueOf())

let initialBalanceUser0
let userWallet0, userWallet3, userWallet11, userWallet12 // using userWallet11 and userWallet12 to sendAll

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendNotification } = require("@services/notifications/notification")

beforeAll(async () => {
  userWallet0 = await getUserWallet(0)
  userWallet3 = await getUserWallet(3)
  userWallet11 = await getUserWallet(11)
  userWallet12 = await getUserWallet(12)
  // load funder wallet before use it
  await getUserWallet(4)
  await bitcoindClient.loadWallet({ filename: "outside" })
})

beforeEach(async () => {
  initialBalanceUser0 = await getBTCBalance(userWallet0.user.id)
})

afterEach(async () => {
  await checkIsBalanced()
})

afterAll(async () => {
  jest.restoreAllMocks()
  await bitcoindClient.unloadWallet({ walletName: "outside" })
})

const amount = 10040 // sats
const targetConfirmations = toTargetConfs(1)

describe("UserWallet - onChainPay", () => {
  it("sends a successful payment", async () => {
    const { address } = await createChainAddress({ format: "p2wpkh", lnd: lndOutside1 })

    const sub = subscribeToTransactions({ lnd: lndonchain })
    sub.on("chain_transaction", onchainTransactionEventHandler)

    const results = await Promise.all([
      once(sub, "chain_transaction"),
      userWallet0.onChainPay({ address, amount, targetConfirmations }),
    ])

    expect(results[1]).toBeTruthy()
    await onchainTransactionEventHandler(results[0][0])

    // we don't send a notification for send transaction for now
    // expect(sendNotification.mock.calls.length).toBe(1)
    // expect(sendNotification.mock.calls[0][0].data.type).toBe(NotificationType.OnchainPayment)
    // expect(sendNotification.mock.calls[0][0].data.title).toBe(`Your transaction has been sent. It may takes some time before it is confirmed`)

    // FIXME: does this syntax always take the first match item in the array? (which is waht we want, items are return as newest first)
    const {
      results: [pendingTxn],
    } = await ledger.getAccountTransactions(userWallet0.accountPath, { pending: true })

    const interimBalance = await getBTCBalance(userWallet0.user.id)
    expect(interimBalance).toBe(initialBalanceUser0 - amount - pendingTxn.fee)
    await checkIsBalanced()

    await sleep(1000)

    let txResult = await Wallets.getTransactionsForWalletId({
      walletId: userWallet0.user.id,
    })
    if (txResult.error instanceof Error || txResult.result === null) {
      throw txResult.error
    }
    let txs = txResult.result
    const pendingTxs = filter(txs, { status: TxStatus.Pending })
    expect(pendingTxs.length).toBe(1)
    expect(pendingTxs[0].settlementAmount).toBe(-amount - pendingTxs[0].settlementFee)

    // const subSpend = subscribeToChainSpend({ lnd: lndonchain, bech32_address: address, min_height: 1 })

    await Promise.all([
      once(sub, "chain_transaction"),
      mineBlockAndSync({ lnds: [lndonchain] }),
    ])

    await sleep(1000)

    // expect(sendNotification.mock.calls.length).toBe(2)  // FIXME: should be 1

    expect(sendNotification.mock.calls[0][0].title).toBe(
      getTitle[NotificationType.OnchainPayment]({ amount }),
    )
    expect(sendNotification.mock.calls[0][0].user._id).toStrictEqual(userWallet0.user._id)
    expect(sendNotification.mock.calls[0][0].data.type).toBe(
      NotificationType.OnchainPayment,
    )

    const {
      results: [{ pending, fee, feeUsd }],
    } = await ledger.getAccountTransactions(userWallet0.accountPath, {
      hash: pendingTxn.hash,
    })
    const feeRates = getFeeRates()

    expect(pending).toBe(false)
    expect(fee).toBe(feeRates.withdrawFeeFixed + 7050)
    expect(feeUsd).toBeGreaterThan(0)

    txResult = await Wallets.getTransactionsForWalletId({
      walletId: userWallet0.user.id,
    })
    if (txResult.error instanceof Error || txResult.result === null) {
      throw txResult.error
    }
    txs = txResult.result
    const txn = txs.find(
      (tx: WalletTransaction) =>
        tx.initiationVia === PaymentInitiationMethod.OnChain && tx.id === pendingTxn.id,
    )
    expect(txn).toBeTruthy()
    expect(txn?.settlementAmount).toBe(-amount - fee)
    expect(txn?.deprecated.type).toBe("onchain_payment")

    const finalBalance = await getBTCBalance(userWallet0.user.id)
    expect(finalBalance).toBe(initialBalanceUser0 - amount - fee)
    sub.removeAllListeners()
  })

  it("sends all in a successful payment", async () => {
    const { address } = await createChainAddress({ format: "p2wpkh", lnd: lndOutside1 })

    const sub = subscribeToTransactions({ lnd: lndonchain })
    sub.on("chain_transaction", onchainTransactionEventHandler)

    const initialBalanceUser11 = await getBTCBalance(userWallet11.user.id)

    const results = await Promise.all([
      once(sub, "chain_transaction"),
      userWallet11.onChainPay({ address, amount: 0, sendAll: true, targetConfirmations }),
    ])

    expect(results[1]).toBeTruthy()
    await onchainTransactionEventHandler(results[0][0])

    // we don't send a notification for send transaction for now
    // expect(sendNotification.mock.calls.length).toBe(1)
    // expect(sendNotification.mock.calls[0][0].data.type).toBe(NotificationType.OnchainPayment)
    // expect(sendNotification.mock.calls[0][0].data.title).toBe(`Your transaction has been sent. It may takes some time before it is confirmed`)

    // FIXME: does this syntax always take the first match item in the array? (which is waht we want, items are return as newest first)
    const {
      results: [pendingTxn],
    } = await ledger.getAccountTransactions(userWallet11.accountPath, { pending: true })

    const interimBalance = await getBTCBalance(userWallet11.user.id)
    expect(interimBalance).toBe(0)
    await checkIsBalanced()

    await sleep(1000)

    let txResult = await Wallets.getTransactionsForWalletId({
      walletId: userWallet11.user.id,
    })
    if (txResult.error instanceof Error || txResult.result === null) {
      throw txResult
    }
    let txs = txResult.result
    const pendingTxs = filter(txs, { status: TxStatus.Pending })
    expect(pendingTxs.length).toBe(1)
    expect(pendingTxs[0].settlementAmount).toBe(-initialBalanceUser11)

    // const subSpend = subscribeToChainSpend({ lnd: lndonchain, bech32_address: address, min_height: 1 })

    await Promise.all([
      once(sub, "chain_transaction"),
      mineBlockAndSync({ lnds: [lndonchain] }),
    ])

    await sleep(1000)

    // expect(sendNotification.mock.calls.length).toBe(2)  // FIXME: should be 1

    /// TODO Still showing amount, find where this happens...
    // expect(sendNotification.mock.calls[0][0].title).toBe(
    //   getTitle[NotificationType.OnchainPayment]({ amount: initialBalanceUser1 }),
    // )
    expect(sendNotification.mock.calls[0][0].data.type).toBe(
      NotificationType.OnchainPayment,
    )

    const {
      results: [{ pending, fee, feeUsd }],
    } = await ledger.getAccountTransactions(userWallet11.accountPath, {
      hash: pendingTxn.hash,
    })
    const feeRates = getFeeRates()

    expect(pending).toBe(false)
    expect(fee).toBe(feeRates.withdrawFeeFixed + 7050) // 7050?
    expect(feeUsd).toBeGreaterThan(0)

    txResult = await Wallets.getTransactionsForWalletId({
      walletId: userWallet11.user.id,
    })
    if (txResult.error instanceof Error || txResult.result === null) {
      throw txResult.error
    }
    txs = txResult.result
    const txn = txs.find(
      (tx) =>
        tx.initiationVia === PaymentInitiationMethod.OnChain && tx.id === pendingTxn.id,
    )
    expect(txn).toBeTruthy()
    expect(txn?.settlementAmount).toBe(-initialBalanceUser11)
    expect(txn?.deprecated.type).toBe("onchain_payment")

    const finalBalance = await getBTCBalance(userWallet11.user.id)
    expect(finalBalance).toBe(0)
    sub.removeAllListeners()
  })

  it("sends a successful payment with memo", async () => {
    const memo = "this is my onchain memo"
    const { address } = await createChainAddress({ format: "p2wpkh", lnd: lndOutside1 })
    const paymentResult = await userWallet0.onChainPay({
      address,
      amount,
      memo,
      targetConfirmations,
    })
    expect(paymentResult).toBe(true)
    const { result: txs, error } = await Wallets.getTransactionsForWalletId({
      walletId: userWallet0.user.id,
    })
    if (error instanceof Error || txs === null) {
      throw error
    }
    const firstTxs = first(txs)
    if (!firstTxs) {
      throw Error("No transactions found")
    }
    expect(firstTxs.deprecated.description).toBe(memo)
    await mineBlockAndSync({ lnds: [lndonchain] })
  })

  it("sends an on us transaction", async () => {
    const address = await Wallets.createOnChainAddress(userWallet3.user.id)
    if (address instanceof Error) throw address

    const initialBalanceUser3 = await getBTCBalance(userWallet3.user.id)

    const paid = await userWallet0.onChainPay({ address, amount, targetConfirmations })

    const finalBalanceUser0 = await getBTCBalance(userWallet0.user.id)
    const finalBalanceUser3 = await getBTCBalance(userWallet3.user.id)

    expect(paid).toBe(true)
    expect(finalBalanceUser0).toBe(initialBalanceUser0 - amount)
    expect(finalBalanceUser3).toBe(initialBalanceUser3 + amount)

    const {
      results: [{ pending, fee, feeUsd }],
    } = await ledger.getAccountTransactions(userWallet0.accountPath, {
      type: "onchain_on_us",
    })

    expect(pending).toBe(false)
    expect(fee).toBe(0)
    expect(feeUsd).toBe(0)
  })

  it("sends an on us transaction with memo", async () => {
    const memo = "this is my onchain memo"

    const address = await Wallets.createOnChainAddress(userWallet3.user.id)
    if (address instanceof Error) throw address

    const paid = await userWallet0.onChainPay({
      address,
      amount,
      memo,
      targetConfirmations,
    })

    expect(paid).toBe(true)

    const matchTx = (tx: WalletTransaction) =>
      tx.initiationVia === "onchain" &&
      tx.deprecated.type === "onchain_on_us" &&
      tx.address === address

    const { result: txs, error } = await Wallets.getTransactionsForWalletId({
      walletId: userWallet0.user.id,
    })
    if (error instanceof Error || txs === null) {
      throw error
    }
    const filteredTxs = txs.filter(matchTx)
    expect(filteredTxs.length).toBe(1)
    expect(filteredTxs[0].deprecated.description).toBe(memo)

    // receiver should not know memo from sender
    const { result: txsUser3, error: error2 } = await Wallets.getTransactionsForWalletId({
      walletId: userWallet3.user.id as WalletId,
    })
    if (error2 instanceof Error || txsUser3 === null) {
      throw error2
    }
    const filteredTxsUser3 = txsUser3.filter(matchTx)
    expect(filteredTxsUser3.length).toBe(1)
    expect(filteredTxsUser3[0].deprecated.description).not.toBe(memo)
  })

  it("sends all with an on us transaction", async () => {
    const initialBalanceUser12 = await getBTCBalance(userWallet12.user.id)

    const address = await Wallets.createOnChainAddress(userWallet3.user.id)
    if (address instanceof Error) throw address

    const initialBalanceUser3 = await getBTCBalance(userWallet3.user.id)

    const paid = await userWallet12.onChainPay({
      address,
      amount: 0,
      sendAll: true,
      targetConfirmations,
    })

    const finalBalanceUser12 = await getBTCBalance(userWallet12.user.id)
    const finalBalanceUser3 = await getBTCBalance(userWallet3.user.id)

    expect(paid).toBe(true)
    expect(finalBalanceUser12).toBe(0)
    expect(finalBalanceUser3).toBe(initialBalanceUser3 + initialBalanceUser12)

    const {
      results: [{ pending, fee, feeUsd }],
    } = await ledger.getAccountTransactions(userWallet12.accountPath, {
      type: "onchain_on_us",
    })

    expect(pending).toBe(false)
    expect(fee).toBe(0)
    expect(feeUsd).toBe(0)
  })

  it("fails if try to send a transaction to self", async () => {
    const address = await Wallets.createOnChainAddress(userWallet0.user.id)
    if (address instanceof Error) throw address

    await expect(
      userWallet0.onChainPay({ address, amount, targetConfirmations }),
    ).rejects.toThrow()
  })

  it("fails if an on us payment has insufficient balance", async () => {
    const address = await Wallets.createOnChainAddress(userWallet3.user.id)
    if (address instanceof Error) throw address
    await expect(
      userWallet0.onChainPay({
        address,
        amount: initialBalanceUser0 + 1,
        targetConfirmations,
      }),
    ).rejects.toThrow()
  })

  it("fails if has insufficient balance", async () => {
    const { address } = await createChainAddress({
      lnd: lndOutside1,
      format: "p2wpkh",
    })
    const initialBalanceUser3 = await getBTCBalance(userWallet3.user.id)

    //should fail because user does not have balance to pay for on-chain fee
    await expect(
      userWallet3.onChainPay({
        address,
        amount: initialBalanceUser3,
        targetConfirmations,
      }),
    ).rejects.toThrow()
  })

  it("fails if send all with a nonzero amount", async () => {
    const address = await Wallets.createOnChainAddress(userWallet3.user.id)
    if (address instanceof Error) throw address

    await expect(
      userWallet0.onChainPay({ address, amount, sendAll: true, targetConfirmations }),
    ).rejects.toThrow()
  })

  it("fails if has negative amount", async () => {
    const amount = -1000
    const { address } = await createChainAddress({ format: "p2wpkh", lnd: lndOutside1 })
    await expect(
      userWallet0.onChainPay({ address, amount, targetConfirmations }),
    ).rejects.toThrow()
  })

  it("fails if withdrawal limit hit", async () => {
    const { address } = await createChainAddress({
      lnd: lndOutside1,
      format: "p2wpkh",
    })

    const timestampYesterday = new Date(Date.now() - MS_PER_DAY)
    const [result] = await Transaction.aggregate([
      {
        $match: {
          accounts: userWallet0.accountPath,
          type: { $ne: "on_us" },
          timestamp: { $gte: timestampYesterday },
        },
      },
      { $group: { _id: null, outgoingSats: { $sum: "$debit" } } },
    ])
    const { outgoingSats } = result || { outgoingSats: 0 }

    const userLimits = getUserLimits({ level: userWallet0.user.level })
    const amount = userLimits.withdrawalLimit - outgoingSats + 1

    await expect(
      userWallet0.onChainPay({ address, amount, targetConfirmations }),
    ).rejects.toThrow(TransactionRestrictedError)
  })

  it("fails if the amount is less than on chain dust amount", async () => {
    const address = await bitcoindOutside.getNewAddress()
    const onChainWalletConfig = getOnChainWalletConfig()
    expect(
      userWallet0.onChainPay({
        address,
        amount: onChainWalletConfig.dustThreshold - 1,
        targetConfirmations,
      }),
    ).rejects.toThrow()
  })

  describe("2FA", () => {
    it("fails to pay above 2fa limit without 2fa token", async () => {
      enable2FA({ wallet: userWallet0 })
      const remainingLimit = await getRemainingTwoFALimit(userWallet0.user.id)
      expect(remainingLimit).not.toBeInstanceOf(Error)
      if (remainingLimit instanceof Error) return remainingLimit

      expect(
        userWallet0.onChainPay({
          address: RANDOM_ADDRESS,
          amount: remainingLimit + 1,
          targetConfirmations,
        }),
      ).rejects.toThrowError(TwoFAError)
    })

    it("sends a successful large payment with a 2fa code", async () => {
      enable2FA({ wallet: userWallet0 })

      const initialBalance = await getBTCBalance(userWallet0.user.id)
      const { address } = await createChainAddress({ format: "p2wpkh", lnd: lndOutside1 })
      const twoFAToken = generateTokenHelper({
        secret: userWallet0.user.twoFA.secret,
      })
      const amount = userWallet0.user.twoFA.threshold + 1
      const paid = await userWallet0.onChainPay({
        address,
        amount,
        twoFAToken,
        targetConfirmations,
      })

      expect(paid).toBe(true)

      await mineBlockAndSyncAll()
      const result = await Wallets.updateOnChainReceipt({ logger: baseLogger })
      if (result instanceof Error) {
        throw result
      }

      const { result: txs, error } = await Wallets.getTransactionsForWalletId({
        walletId: userWallet0.user.id,
      })

      if (error instanceof Error || txs === null) {
        throw error
      }

      // settlementAmount is negative
      const expectedBalance = initialBalance + txs[0].settlementAmount
      const finalBalance = await getBTCBalance(userWallet0.user.id)
      expect(expectedBalance).toBe(finalBalance)
    })
  })
})
