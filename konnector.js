'use strict'

const cheerio = require('cheerio')
const moment = require('moment')

const {
    log,
    BaseKonnector,
    saveBills,
    linkBankOperation
} = require('cozy-konnector-libs')

const request = require('request-promise')

const rq = request.defaults({
  resolveWithFullResponse: true,
  followAllRedirects: true
})

const accountUrl = 'https://moncompte.numericable.fr'
const connectionUrl = 'https://connexion.numericable.fr'

function authenticate (params) {
  return fetchAppKey()
    .then(appKey => fetchAccessToken(appKey, params))
    .catch(handleErrorAndTerminate.bind(this, 'LOGIN_FAILED'))
    .then(authenticateWithToken)
    .catch(handleErrorAndTerminate.bind(this, 'UNKNOWN_ERROR'))
}

function handleErrorAndTerminate (criticalErrorMessage, sourceError) {
  log('error', sourceError.message)
  return this.terminate(criticalErrorMessage)
}

function fetchAppKey () {
  log('info', 'Fetching app key')
  return rq({
    method: 'GET',
    jar: true,
    url: `${accountUrl}/pages/connection/Login.aspx`
  })
    .then(scrapAppKey)
}

function scrapAppKey (response) {
  const $ = cheerio.load(response.body)
  const appKey = $('#PostForm input[name="appkey"]').attr('value')

  if (!appKey) {
    throw new Error('Numericable: could not retrieve app key')
  }

  global.gc()

  return appKey
}

function fetchAccessToken (appKey, params) {
  log('info', `Logging in with appKey ${appKey}`)
  return rq({
    method: 'POST',
    jar: true,
    url: `${connectionUrl}/Oauth/Oauth.php`,
    form: {
      action: 'connect',
      linkSSO: `${connectionUrl}/pages/connection/Login.aspx?link=HOME`,
      appkey: appKey,
      isMobile: ''
    }
  }).then(() => rq({
    method: 'POST',
    jar: true,
    url: `${connectionUrl}/Oauth/login/`,
    form: {
      login: params.login,
      pwd: params.password
    }
  })).then(scrapAccessToken)
}

function scrapAccessToken (response) {
  const $ = cheerio.load(response.body)
  const accessToken = $('#accessToken').attr('value')

  if (!accessToken) throw new Error('Token fetching failed')

  global.gc()

  return accessToken
}

function authenticateWithToken (accessToken) {
  log('info', 'Authenticating by token')
  return rq({
    method: 'POST',
    jar: true,
    url: `${accountUrl}/pages/connection/Login.aspx?link=HOME`,
    qs: {
      accessToken: accessToken
    }
  })
}

function synchronize (params) {
  return fetchPage()
    .then(parsePage)
    .then(bills => saveBills(bills, params))
    .then(customLinkBankOperation)
}

function fetchPage () {
  log('info', 'Fetching bills page')
  return rq({
    method: 'GET',
    jar: true,
    url: `${accountUrl}/pages/billing/Invoice.aspx`
  })
    .catch(err => {
      if (err) {
        log('error', 'An error occured while fetching bills page')
        return this.terminate('UNKNOWN_ERROR')
      }
    })
}

module.exports = new BaseKonnector(function fetch (params) {
  return authenticate.call(this, params)
    .then(synchronize.bind(this, params))
})

// Layer to parse the fetched page to extract bill data.
function parsePage (response) {
  const bills = {}
  bills.fetched = []
  const $ = cheerio.load(response.body)

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
    pdfurl: accountUrl + billLink.attr('href')
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
      pdfurl: accountUrl + billLink.attr('href')
    }

    if (bill.date && bill.amount && bill.pdfurl) {
      bills.fetched.push(bill)
    }
  })

  log('info', `${bills.fetched.length} bill(s) retrieved`)

  if (!bills.fetched.length) {
    log('info', 'no bills retrieved')
  }

  return bills
}

function customLinkBankOperation (bills) {
  return linkBankOperation(bills.fetched, '', {
    minDateDelta: 1,
    maxDateDelta: 1,
    amountDelta: 0.1,
    identifiers: ['numericable']
  })
  .then(() => bills.fetched)
  .catch(err => {
    log('error', err)
    return this.terminate('UNKNOWN_ERROR')
  })
}
