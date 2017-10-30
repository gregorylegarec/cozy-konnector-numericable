'use strict'

const request = require('request')
const cheerio = require('cheerio')
const moment = require('moment')

const {
    log,
    baseKonnector,
    filterExisting,
    linkBankOperation,
    saveDataAndFile,
    models
} = require('cozy-konnector-libs')
const Bill = models.bill

module.exports = baseKonnector.createNew({
  name: 'Numéricable',
  description: 'konnector description numericable',
  vendorLink: 'https://www.numericable.fr/',

  category: 'isp',

  dataType: ['bill'],

  models: [Bill],

  fetchOperations: [
    login,
    parsePage,
    customFilterExisting,
    customSaveDataAndFile,
    customLinkBankOperation
  ]
})

const fileOptions = {
  vendor: 'Numéricable',
  dateFormat: 'YYYYMMDD'
}

function login (requiredFields, entries, data, next) {
  const accountUrl = 'https://moncompte.numericable.fr'
  const connectionUrl = 'https://connexion.numericable.fr'
  const appKeyOptions = {
    method: 'GET',
    jar: true,
    url: `${accountUrl}/pages/connection/Login.aspx`
  }

  const logInOptions = {
    method: 'POST',
    jar: true,
    url: `${connectionUrl}/Oauth/Oauth.php`,
    form: {
      action: 'connect',
      linkSSO: `${connectionUrl}/pages/connection/Login.aspx?link=HOME`,
      appkey: '',
      isMobile: ''
    }
  }

  const redirectOptions = {
    method: 'POST',
    jar: true,
    url: connectionUrl
  }

  const signInOptions = {
    method: 'POST',
    jar: true,
    url: `${connectionUrl}/Oauth/login/`,
    form: {
      login: requiredFields.login,
      pwd: requiredFields.password
    }
  }

  const tokenAuthOptions = {
    method: 'POST',
    jar: true,
    url: `${accountUrl}/pages/connection/Login.aspx?link=HOME`,
    qs: {
      accessToken: ''
    }
  }

  const billOptions = {
    method: 'GET',
    jar: true,
    uri: `${accountUrl}/pages/billing/Invoice.aspx`
  }

  log('info', 'Getting appkey')
  request(appKeyOptions, (err, res, body) => {
    let appKey = ''
    let $

    if (!err) {
      $ = cheerio.load(body)
      appKey = $('#PostForm input[name="appkey"]').attr('value')
    }

    if (!appKey) {
      log('error', 'LOGIN_FAILED')
      log('error', 'Numericable: could not retrieve app key')
      return next('LOGIN_FAILED')
    }

    logInOptions.form.appkey = appKey

    log('info', 'Logging in')
    request(logInOptions, (err) => {
      if (err) {
        log('error', 'Login failed')
        return next('LOGIN_FAILED')
      }

      log('info', 'Signing in')
      request(signInOptions, (err, res) => {
        let redirectUrl = ''
        if (res && res.headers) {
          redirectUrl = res.headers.location
          // Numéricable returns a 302 even in case of errors
          if (!redirectUrl || (redirectUrl === '/Oauth/connect/')) {
            err = true
          }
        }

        if (err) {
          log('error', 'LOGIN_FAILED')
          log('error', 'Signin failed')
          return next('LOGIN_FAILED')
        }

        redirectOptions.url += redirectUrl

        log('info', 'Fetching access token')
        request(redirectOptions, (err, res, body) => {
          let accessToken = ''

          if (!err) {
            $ = cheerio.load(body)
            accessToken = $('#accessToken').attr('value')
          }

          if (!accessToken) {
            log('error', 'Token fetching failed')
            return next('UNKNOWN_ERROR')
          }

          tokenAuthOptions.qs.accessToken = accessToken

          log('info', 'Authenticating by token')
          request(tokenAuthOptions, (err) => {
            if (err) {
              log('error', 'Authentication by token failed')
              return next('UNKNOWN_ERROR')
            }

            log('info', 'Fetching bills page')
            request(billOptions, (err, res, body) => {
              if (err) {
                log('error', 'An error occured while fetching bills page')
                return next('UNKNOWN_ERROR')
              }

              data.html = body
              return next()
            })
          })
        })
      })
    })
  })
}

// Layer to parse the fetched page to extract bill data.
function parsePage (requiredFields, bills, data, next) {
  bills.fetched = []
  const $ = cheerio.load(data.html)
  const baseURL = 'https://moncompte.numericable.fr'

  // Analyze bill listing table.
  log('info', 'Parsing bill page')

  // First bill
  const firstBill = $('#firstFact')
  let billDate = firstBill.find('h2 span')
  let billTotal = firstBill.find('p.right')
  let billLink = firstBill.find('a.linkBtn')

  let bill = {
    date: moment(billDate.html(), 'DD/MM/YYYY'),
    amount: parseFloat(billTotal.html().replace(' €', '').replace(',', '.')),
    pdfurl: baseURL + billLink.attr('href')
  }

  if (bill.date && bill.amount && bill.pdfurl) {
    bills.fetched.push(bill)
  }

  // Other bills
  $('#facture > div[id!="firstFact"]').each((index, element) => {
    billDate = $(element).find('h3')
              .html()
              .substr(3)
    billTotal = $(element).find('p.right')
    billLink = $(element).find('a.linkBtn')

    // Add a new bill information object.
    bill = {
      date: moment(billDate, 'DD/MM/YYYY'),
      amount: parseFloat(billTotal.html().replace(' €', '').replace(',', '.')),
      pdfurl: baseURL + billLink.attr('href')
    }

    if (bill.date && bill.amount && bill.pdfurl) {
      bills.fetched.push(bill)
    }
  })

  log('info', `${bills.fetched.length} bill(s) retrieved`)

  if (!bills.fetched.length) {
    return next('no bills retrieved')
  }

  next()
}

function customFilterExisting (requiredFields, entries, data, next) {
  filterExisting(null, Bill)(requiredFields, entries, data, next)
}

function customSaveDataAndFile (requiredFields, entries, data, next) {
  saveDataAndFile(null, Bill, fileOptions, ['bill'])(
      requiredFields, entries, data, next)
}

function customLinkBankOperation (requiredFields, entries, data, next) {
  linkBankOperation(entries.fetched, '', {
    minDateDelta: 1,
    maxDateDelta: 1,
    amountDelta: 0.1,
    identifiers: ['numericable']
  })
  .then(() => next(null, entries.fetched))
  .catch(err => next(err))
}
