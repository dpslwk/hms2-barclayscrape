#!/usr/bin/env node
const util = require('util');
const path = require('path');
const fs = require('fs');
const fs_writeFile = util.promisify(fs.writeFile);

const program = require('commander');
const Configstore = require('configstore');
const prompt = require('syncprompt');
const axios = require('axios');
const oauth = require('axios-oauth-client');
const tokenProvider = require('axios-token-interceptor');
const parseOFX = require('ofx-js').parse;

const pkg = require('./package.json');
const session = require('barclayscrape/session.js');

const conf = new Configstore(pkg.name);

program
  .version(pkg.version)
  .description('Programmatic access to Barclays online banking and upload to hms2.')
  .option('--otp [pin]', 'PINSentry code')
  .option('--motp [pin]', 'Mobile PINSentry code')
  .option('--plogin', 'Login using passcode and password')
  .option('--no-headless', 'Show browser window when interacting');

program
  .command('list')
  .description('List all available accounts')
  .action(async options => {
    var sess;
    try {
      sess = await auth();
    } catch (err) {
      console.error(err);
      return;
    }

    try {
      const accounts = await sess.accounts();
      console.table(accounts.map(acc => [acc.number, exportLabel(acc)]));
    } catch (err) {
      console.error(err);
    } finally {
      await sess.close();
    }
  });

program
  .command('hms2_upload')
  .description('Fetch latest transactions and upload to hms2')
  .option('-b, --bypassssl', 'Bypass ssl checks.')
  .action(async (options) => {
    // console.log('hms2_upload');
    if (options.bypassssl) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    }

    if (!(conf.has('hms2clientId') && conf.has('hms2clientSecret') && conf.has('hms2url'))) {
      console.error(
        'HMS2-Barclayscrape has not been configured for HMS 2 upload. Please run `hms2-barclayscrape config_hms2`',
      );
      program.help();
    }

    // setup oauth and axios
    const getOwnerCredentials = oauth.client(axios.create(), {
      url: conf.get('hms2url') + 'oauth/token',
      grant_type: 'client_credentials',
      client_id: conf.get('hms2clientId'),
      client_secret: conf.get('hms2clientSecret'),
    });

    const instance = axios.create();
    instance.interceptors.request.use(
      // Wraps axios-token-interceptor with oauth-specific configuration,
      // fetches the token using the desired claim method, and caches
      // until the token expires
      oauth.interceptor(tokenProvider, getOwnerCredentials)
    );
    instance.defaults.headers.common['Accept'] = 'application/json';

    var sess;
    try {
      sess = await auth();
    } catch (err) {
      console.error(err);
      return;
    }

    try {
      const accounts = await sess.accounts();
      for (let account of accounts) {
        const ofxString = await account.statementOFX();
        if (ofxString) {
          parseOFX(ofxString).then(ofxData => {
            const statementResponse = ofxData.OFX.BANKMSGSRSV1.STMTTRNRS.STMTRS;
            const accountId = statementResponse.BANKACCTFROM.ACCTID;
            const transactions = statementResponse.BANKTRANLIST.STMTTRN;

            // split to accountId in separate sort code and number
            let accountSortCode = accountId.substring(0, 2) + '-'
              + accountId.substring(2, 4) + '-'
              + accountId.substring(4, 6);
            let accountNumber = accountId.substring(6);

            // console.log(transactions[0]);
            /*
             * example JSON for request
             * [
             *     {
             *         "sortCode" : "77-22-24",
             *         "accountNumber" : "13007568",
             *         "date" : "2017-07-17",
             *         "description" : "Edward Murphy HSNTSBBPRK86CWPV 4",
             *         "amount" : 500
             *     },
             *     {
             *         "sortCode" : "77-22-24",
             *         "accountNumber" : "13007568",
             *         "date" : "2017-07-16",
             *         "description" : "Gordon Johnson HSNTSB27496WPB2M 53",
             *         "amount" : 700
             *     },
             *     {
             *         "sortCode" : "77-22-24",
             *         "accountNumber" : "13007568",
             *         "date" : "2017-07-16",
             *         "description" : "BIZSPACE",
             *         "amount" : -238963
             *     }
             * ]
             */
            let mappedTransactions = transactions.filter(function (t) {
              // filter any with FITID: less than 200000000000000
              // Barclays now returns non_unique fit_ids in a low range for uncleared transactions.
              return ! (parseInt(t['FITID']) < 200000000000000);
            }).map(function (t) {
              let txnDate = parseOFXDatetime(t['DTPOSTED']);
              let amount = parseFloat(t['TRNAMT']) * 100;

              let transaction = {
                "sortCode" : accountSortCode,
                "accountNumber" : accountNumber,
                "date" : txnDate.toJSON(),
                "description" : t['NAME'] + ' ' + t['FITID'],
                "amount" : amount
              };

              return transaction;
            });
            // console.log(mappedTransactions[0]);

            // transactions haver been mapped, now to pass onto hms2
            // console.log('Transactions mapped');
            // console.log(mappedTransactions);

            console.log('Uploading ' + account.mumber + ' to HMS 2');
            instance.post(conf.get('hms2url') + 'api/cc/bank-transactions/upload', mappedTransactions)
              .then(function (response) {
                console.log('Transactions Uploaded');
                // console.log(response);
              })
              .catch(function (error) {
                if (error.response) {
                  // The request was made and the server responded with a status code
                  // that falls out of the range of 2xx
                  console.log(error.response.data);
                  console.log(error.response.status);
                  console.log(error.response.headers);
                } else if (error.request) {
                  // The request was made but no response was received
                  // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
                  // http.ClientRequest in node.js
                  console.log(error.request);
                } else {
                  // Something happened in setting up the request that triggered an Error
                  console.log('Error', error.message);
                }
              });
          });
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      await sess.close();
    }
  });

program
  .command('config')
  .description('Set up login details')
  .action(options => {
    var surname = prompt('Enter your surname: ');
    conf.set('surname', surname);
    do {
      var num = prompt('Enter your online banking membership number: ');
      if (num.length != 12) {
        console.log('Membership number should be 12 digits');
      }
    } while (num.length != 12);
    conf.set('membershipno', num);
    console.log(
      "\nIf you're going to be logging in using PinSentry, please enter the last few\n" +
        "(usually four) digits of your card number, which you're prompted for on login.\n" +
        "If you're using Mobile PinSentry, you can leave this blank.\n",
    );
    var digits = prompt('Enter the last digits of your card number: ');
    conf.set('card_digits', digits);

    console.log(
      "\nSome Barclays accounts allow a restricted login, using a memorable passcode and password (using the  --plogin options).\n" +
        "It is recommended you leave this blank, unless you understand the security implications.\n",
    );
    do {
      var passcode = prompt('Enter your 5 digit memorable passcode, or leave blank (recommended): ');
      if ((passcode !== '') && (passcode.length != 5)) {
        console.log('Memorable passcode must be 5 digits');
      }
    } while ((passcode !== '') && (passcode.length != 5));
    conf.set('passcode', passcode);

    var password = '';
    if (passcode !== '') {
        console.log(
          "\nIn addition to your passcode, you must also provide your memorable password (Barclays will request 2 random characters from it).\n"
        );
        password = prompt('Enter your memorable password: ');
    }
    conf.set('password', password);

    console.log(
      "\nIf you want to export statements with a friendly name instead of the account\n" +
        "number, you can add aliases here.\n" +
        "Press enter to continue if you don't need this or once you're finished.\n",
    );
    var account, alias;
    var aliases = {};
    while (true) {
      account = prompt('Enter an account number: ');
      if (!account) {
        break;
      }
      alias = prompt('Enter friendly label: ');
      if (!alias) {
        break;
      }
      aliases[account] = alias;
    }
    conf.set('aliases', aliases);
    console.log('\nBarclayscrape is now configured.');
    console.log('Credentials were saved to: ' + conf.path);
  });

program
  .command('config_hms2')
  .description('Set up HMS 2 OAuth details')
  .action(options => {
    var hms2clientId = prompt('Enter HMS 2 client ID: ');
    conf.set('hms2clientId', hms2clientId);
    var hms2clientSecret = prompt('Enter HMS 2 client secrete: ');
    conf.set('hms2clientSecret', hms2clientSecret);
    var hms2url = prompt('Enter the HMS2 URL (inc http[s]://): ');
    if (hms2url.charAt(hms2url.length -1 ) != '/') {
      hms2url += '/';
    }
    conf.set('hms2url', hms2url);
    console.log('\nHMS2 is now configured.');
    console.log('Credentials were saved to: ' + conf.path);
  });

program.parse(process.argv);

function exportLabel(account) {
  let aliases = conf.get('aliases') || {};
  return aliases[account.number] || account.number;
}

async function auth() {
  if (!(conf.has('surname') && conf.has('membershipno'))) {
    console.error(
      'Barclayscrape has not been configured. Please run `barclayscrape config`',
    );
    program.help();
  }

  if (!(program.otp || program.motp || program.plogin)) {
    console.error('Must specify either --otp, --motp or --plogin');
    program.help();
  }

  if (program.otp && program.otp.length != 8) {
    console.error('OTP should be 8 characters long');
    program.help();
  }

  if (program.motp && program.motp.length != 8) {
    program.motp = prompt('Enter your 8 digit mobile PIN sentry code: ');
  }

  // The --no-sandbox argument is required here for this to run on certain kernels
  // and containerised setups. My understanding is that disabling sandboxing shouldn't
  // cause a security issue as we're only using one tab anyway.
  const sess = await session.launch({
    headless: program.headless,
    args: ['--no-sandbox'],
  });

  try {
    if (program.otp) {
      await sess.loginOTP({
        surname: conf.get('surname'),
        membershipno: conf.get('membershipno'),
        card_digits: conf.get('card_digits'),
        otp: program.otp,
      });
  } else if (program.motp) {
    await sess.loginMOTP({
      surname: conf.get('surname'),
      membershipno: conf.get('membershipno'),
      motp: program.motp,
    });
  } else if (program.plogin) {
    await sess.loginPasscode({
      surname: conf.get('surname'),
      membershipno: conf.get('membershipno'),
      passcode: conf.get('passcode'),
      password: conf.get('password'),
  });
}
  } catch (err) {
    try {
      await sess.close();
    } catch (e) {}
    throw err;
  }
  return sess;
}

function parseOFXDatetime(ofxDate) {
  // does not support fractional timezone offsets, which the spec also defines (+12.00 -12.00)
  const regex = /^\s*(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?(?:\.(\d{3}))?(?:\[([+-]?\d+)\:\w{3}\])?\s*$/gm;
  let m;

  while ((m = regex.exec(ofxDate)) !== null) {
    let year = m[1];
    let mon = m[2];
    let day = m[3];
    let hour = m[4];
    let min = m[5];
    let sec = m[6];
    let msec = m[7];
    let off = m[8];

    if (hour === undefined) {
      return new Date(Date.UTC(year, mon - 1, day, 0, 0, 0));
    } else if (ofxDate.length === 14) {
      return new Date(Date.UTC(year, mon - 1, day, hour, min, sec));
    }

    if (msec !== undefined && off === undefined) {
      return new Date(
        Date.UTC(year, mon - 1, day, hour, min, sec, msec)
      );
    }

    if (msec === undefined && off) {
      msec = '000';
    }

    if (msec !== undefined && off) {
      let timezone
      if (off.charAt(0) == '+' || off.charAt(0) == '-') {
        timezone = off.charAt(0);
        off = off.substring(1);
      } else {
        timezone = '+';
      }

      if (off === '0') {
        timezone = 'Z';
      } else if (off.length === 1) { // 0-9
        timezone += `0${off}00`;
      } else if (off.length === 2) { // 10-12
        timezone += `${off}00`;
      }

      const dateString =
        `${year}-${mon}-${day}` +
        `T${hour}:${min}:` +
        `${sec}.${msec}${timezone}`;

      const date = new Date(dateString);
      return new Date(
        Date.UTC(
          date.getUTCFullYear(),
          date.getUTCMonth(),
          date.getUTCDate(),
          date.getUTCHours(),
          date.getUTCMinutes(),
          date.getUTCSeconds(),
          date.getUTCMilliseconds()
        )
      );
    }
  }
}