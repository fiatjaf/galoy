import { toSats } from "@domain/bitcoin"
import { isOnChainTransaction, LedgerTransactionType } from "@domain/ledger"
import { MEMO_SHARING_SATS_THRESHOLD } from "@config/app"
import { SettlementMethod, PaymentInitiationMethod } from "./tx-methods"
import { TxStatus } from "./tx-status"

const filterPendingIncoming = (
  walletId: WalletId,
  pendingTransactions: SubmittedTransaction[],
  addresses: OnChainAddress[],
  usdPerSat: UsdPerSat,
): WalletTransaction[] => {
  const walletTransactions: WalletTransaction[] = []
  pendingTransactions.forEach(({ rawTx, createdAt }) => {
    rawTx.outs.forEach(({ sats, address }) => {
      if (address && addresses.includes(address)) {
        walletTransactions.push({
          id: rawTx.txHash,
          walletId,
          initiationVia: PaymentInitiationMethod.OnChain,
          settlementVia: SettlementMethod.OnChain,
          deprecated: {
            description: "pending",
            usd: usdPerSat * sats,
            feeUsd: 0,
            type: LedgerTransactionType.OnchainReceipt,
          },
          otherPartyUsername: null,
          settlementFee: toSats(0),
          transactionHash: rawTx.txHash,
          status: TxStatus.Pending,
          memo: null,
          createdAt: createdAt,
          settlementAmount: sats,
          settlementUsdPerSat: usdPerSat,
          address,
        })
      }
    })
  })
  return walletTransactions
}

export const fromLedger = (
  ledgerTransactions: LedgerTransaction[],
): ConfirmedTransactionHistory => {
  const transactions: WalletTransaction[] = ledgerTransactions.map(
    ({
      id,
      walletId,
      memoFromPayer,
      lnMemo,
      type,
      credit,
      debit,
      fee,
      usd,
      feeUsd,
      paymentHash,
      txHash,
      pubkey,
      username,
      address,
      pendingConfirmation,
      timestamp,
    }) => {
      const settlementAmount = toSats(credit - debit)

      const description = translateDescription({
        type,
        memoFromPayer,
        lnMemo,
        credit,
        username,
      })

      const memo = translateMemo({
        memoFromPayer,
        lnMemo,
        credit,
      })

      const status = pendingConfirmation ? TxStatus.Pending : TxStatus.Success

      const baseTransaction = {
        id,
        walletId,
        settlementAmount,
        settlementFee: toSats(fee || 0),
        settlementUsdPerSat: Math.abs(usd / settlementAmount),
        status,
        memo,
        createdAt: timestamp,
        deprecated: {
          description,
          usd,
          feeUsd,
          type,
        },
      }

      let txType = type
      if (type == LedgerTransactionType.IntraLedger && paymentHash) {
        txType = LedgerTransactionType.LnIntraLedger
      }

      switch (txType) {
        case LedgerTransactionType.IntraLedger:
          return {
            ...baseTransaction,
            initiationVia: {
              type: PaymentInitiationMethod.IntraLedger,
              walletId: walletId,
              counterPartyUsername: username || null,
            },
            settlementVia: {
              type: SettlementMethod.IntraLedger,
              walletId: walletId,
              counterPartyUsername: username || null,
            },
          }

        case LedgerTransactionType.OnchainIntraLedger:
          return {
            ...baseTransaction,
            initiationVia: {
              type: PaymentInitiationMethod.OnChain,
              address,
            },
            settlementVia: {
              type: SettlementMethod.IntraLedger,
              walletId: walletId,
              counterPartyUsername: username || null,
            },
          }

        case LedgerTransactionType.OnchainPayment:
        case LedgerTransactionType.OnchainReceipt:
          return {
            ...baseTransaction,
            initiationVia: {
              type: PaymentInitiationMethod.OnChain,
              address,
            },
            settlementVia: {
              type: SettlementMethod.OnChain,
              transactionHash: txHash,
            },
          }

        case LedgerTransactionType.LnIntraLedger:
          return {
            ...baseTransaction,
            initiationVia: {
              type: PaymentInitiationMethod.Lightning,
              paymentRequest,
              paymentHash,
              pubkey,
            },
            settlementVia: {
              type: SettlementMethod.IntraLedger,
              walletId: walletId,
              counterPartyUsername: username || null,
            },
          }

        case LedgerTransactionType.Payment:
        case LedgerTransactionType.Invoice:
          return {
            ...baseTransaction,
            initiationVia: {
              type: PaymentInitiationMethod.Lightning,
              paymentRequest,
              paymentHash,
              pubkey,
            },
            settlementVia: {
              type: SettlementMethod.Lightning,
              paymentSecret,
            },
          }
      }

      // if (isOnChainTransaction(type)) {
      //   return {
      //     ...baseTransaction,
      //     initiationVia: PaymentInitiationMethod.OnChain,
      //     settlementVia:
      //       type === LedgerTransactionType.OnchainIntraLedger
      //         ? SettlementMethod.IntraLedger
      //         : SettlementMethod.OnChain,
      //     address,
      //     otherPartyUsername: username || null,
      //     transactionHash: txHash as OnChainTxHash,
      //   }
      // }
      // if (paymentHash) {
      //   return {
      //     ...baseTransaction,
      //     initiationVia: PaymentInitiationMethod.Lightning,
      //     settlementVia:
      //       type === LedgerTransactionType.IntraLedger
      //         ? SettlementMethod.IntraLedger
      //         : SettlementMethod.Lightning,
      //     paymentHash: paymentHash as PaymentHash,
      //     pubkey: pubkey as Pubkey,
      //     otherPartyUsername: username || null,
      //   }
      // }
      // return {
      //   ...baseTransaction,
      //   initiationVia: PaymentInitiationMethod.IntraLedger,
      //   settlementVia: SettlementMethod.IntraLedger,
      //   otherPartyUsername: username || null,
      // }
    },
  )

  return {
    transactions,
    addPendingIncoming: (
      walletId: WalletId,
      pendingIncoming: SubmittedTransaction[],
      addresses: OnChainAddress[],
      usdPerSat: UsdPerSat,
    ): WalletTransactionHistoryWithPending => ({
      transactions: [
        ...filterPendingIncoming(walletId, pendingIncoming, addresses, usdPerSat),
        ...transactions,
      ],
    }),
  }
}

const shouldDisplayMemo = (credit: number) => {
  return credit === 0 || credit >= MEMO_SHARING_SATS_THRESHOLD
}

export const translateDescription = ({
  memoFromPayer,
  lnMemo,
  username,
  type,
  credit,
}: {
  memoFromPayer?: string
  lnMemo?: string
  username?: string
  type: LedgerTransactionType
  credit: number
}): string => {
  if (shouldDisplayMemo(credit)) {
    if (memoFromPayer) {
      return memoFromPayer
    }
    if (lnMemo) {
      return lnMemo
    }
  }

  let usernameDescription
  if (username) {
    usernameDescription = `to ${username}`
    if (credit > 0) {
      usernameDescription = `from ${username}`
    }
  }

  return usernameDescription || type
}

export const translateMemo = ({
  memoFromPayer,
  lnMemo,
  credit,
}: {
  memoFromPayer?: string
  lnMemo?: string
  credit: number
}): string | null => {
  if (shouldDisplayMemo(credit)) {
    if (memoFromPayer) {
      return memoFromPayer
    }
    if (lnMemo) {
      return lnMemo
    }
  }

  return null
}

export const WalletTransactionHistory = {
  fromLedger,
} as const
