// Based on https://github.com/GeeTeam/gt3-server-node-express-bypass/blob/master/app.js

// https://docs.geetest.com/captcha/apirefer/api/server
// doing this: "If the storage space is not sufficient: Send request to check bypass status before starting the verfication process."

import {
  GeetestError,
  GeetestUserFailToPassError,
  UnknownGeetestError,
} from "@domain/geetest/error"
import axios from "axios"
import GeetestLib from "gt3-server-node-express-sdk/sdk/geetest_lib" // galoy fork

async function sendRequest(params) {
  const requestUrl = "https://bypass.geetest.com/v1/bypass_status.php"
  let bypassRes
  try {
    const res = await axios({
      url: requestUrl,
      method: "GET",
      timeout: 5000,
      params: params,
    })
    const resBody = res.status === 200 ? res.data : ""
    bypassRes = resBody["status"]
  } catch (e) {
    bypassRes = ""
  }
  return bypassRes
}

const Geetest = (config): GeetestType => {
  const getBypassStatus = async () => {
    return sendRequest({ gt: config.id })
  }

  const register = async (): Promise<UnknownGeetestError | GeetestRegister> => {
    try {
      const gtLib = new GeetestLib(config.id, config.key)
      const digestmod = "md5"
      const params = {
        digestmod,
        client_type: "native",
      }
      const bypasscache = await getBypassStatus() // not a cache
      let result
      if (bypasscache === "success") {
        result = await gtLib.register(digestmod, params)
      } else {
        result = await gtLib.localRegister()
      }

      const { success, gt, challenge, new_captcha: newCaptcha } = JSON.parse(result.data)
      return { success, gt, challenge, newCaptcha }
    } catch (err) {
      return new UnknownGeetestError(err)
    }
  }

  const validate = async (
    challenge,
    validate,
    seccode,
  ): Promise<boolean | GeetestError> => {
    try {
      const gtLib = new GeetestLib(config.id, config.key)
      const bypasscache = await getBypassStatus() // not a cache
      let result
      const params = []
      if (bypasscache === "success") {
        result = await gtLib.successValidate(challenge, validate, seccode, params)
      } else {
        result = gtLib.failValidate(challenge, validate, seccode)
      }
      if (result.status !== 1) {
        return new GeetestUserFailToPassError()
      }
      return true
    } catch (err) {
      return new UnknownGeetestError(err)
    }
  }

  return { register, validate }
}

export default Geetest
