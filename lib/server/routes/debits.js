'use strict';

const moment = require('moment');
const inherits = require('util').inherits;
const Router = require('./index');
const rawbody = require('../middleware/rawbody');
const log = require('../../logger');
const errors = require('../errors');
const authenticate = require('../middleware').authenticate;
const constants = require('../../constants');
const STRIPE = constants.PAYMENT_PROCESSORS.STRIPE;
const CREDIT_TYPES = constants.CREDIT_TYPES;
const paymentProcessorAdapters = require('../graphql/payment-processor-adapters');
const stripe = require('../vendor/stripe');

/**
* Handles endpoints for all user related operations
*/
function DebitsRouter(options) {
  if(!(this instanceof DebitsRouter)) {
    return new DebitsRouter(options);
  }
  this.models = options.storage.models;

  Router.apply(this, arguments);

  this._verify = authenticate(this.storage);
}

inherits(DebitsRouter, Router);

function getBillingCycle(billingDate) {
  const today = new Date();
  const daysInMonth = (new Date(today.getFullYear(), (today.getMonth()), 0)).getDate();
  const startDayOfMonth = (billingDate > daysInMonth) ? daysInMonth : billingDate;
  const startDate = Date.parse(new Date(
    today.getFullYear(),
    (today.getMonth() - 1),
    startDayOfMonth
  ));
  const endDate = (moment(startDate).add('1', 'month').unix() * 1000);
  return {
    startDate: startDate,
    endDate: endDate
  };
};

function getBalance(credits, debits) {
  const sumCredits = (total, item) => {
    return total + item.paid_amount;
  };

  const sumDebits = (total, item) => {
    return total + item.amount;
  };

  const creditSum = credits.reduce(sumCredits, 0);
  const debitSum = debits.reduce(sumDebits, 0);
  const balance = debitSum - creditSum;

  return balance;
}

function getPromoBalance(credits) {
  return credits.reduce((total, item) => {
    return total + item.promo_amount;
  }, 0);
}

DebitsRouter.prototype.verify = function(req, res, next) {
  if (process.env.NODE_ENV === 'production') {
    const eventId = req.body.id;
    stripe.events.retrieve(eventId, function(err, event) {
      if(err){
        console.error('error verifying stripe event');
        next(err);
      }
      res.locals.event = event;
      next(null);
    })
  } else {
    res.locals.event = req.body;
    res.locals.event.data.object.customer = 'cus_97ADNC3zbcPQkR';
    next(null);
  }
}

DebitsRouter.prototype.debitSync = function(req, res) {
  const stripeAdapter = paymentProcessorAdapters[STRIPE];
  const invoice = res.locals.event.data.object;
  const customerId = invoice.customer;

  if(invoice.object !== 'invoice'){
    return res.sendStatus(400);
  }

  this.models.User.findOne({
    'paymentProcessors.rawData.customer.id': customerId
  })
  .then((user) => {
    const stripeProcessor = user.paymentProcessors
      .find((processor) => (processor.name === STRIPE));
    const billingCycle = getBillingCycle(stripeProcessor.billingDate);
    const params = {
      user: user._id,
      created: {
        $gte: moment(parseInt(billingCycle.startDate, 0)),
        $lte: moment(parseInt(billingCycle.endDate, 0))
      }
    };

    return [
      this.models.Debit.find(params),
      this.models.Credit.find(params),
      this.models.Credit.find({user: user._id}),
      user,
      billingCycle
    ];
  })
  .then((promises) => (Promise.all(promises)))
  .then((results) => {
    const debits = results[0];
    const credits = results[1];
    const allCredits = results[2];
    const user = results[3];
    const billingCycle = results[4];

    const balance = getBalance(credits, debits);
    const promoBalance = getPromoBalance(allCredits);

    console.log(balance, promoBalance);

    const invoiceAmount = (balance - promoBalance < 0) ?
      0 : balance - promoBalance;

    const promoUsed = (promoBalance - balance > 0) ?
      balance : promoBalance;

    const totalAmount = (invoiceAmount < 0) ?
      0 : invoiceAmount

    const newCredit = new this.models.Credit({
      invoiced_amount: invoiceAmount,
      paid_amount: 0,
      promo_amount: promoUsed,
      user: user._id,
      payment_processor: STRIPE,
      type: CREDIT_TYPES.AUTO
    });

    newCredit.save((err, credit) => {
      if(err) {
        throw new Error(err);
      }

      stripe.invoiceItems.create({
        customer: customerId,
        amount: totalAmount,
        currency: 'usd',
        metadata: {
          userId: JSON.stringify(user._id),
          creditId: JSON.stringify(credit._id),
          promoBalance: promoBalance,
          promoUsed: promoUsed,
          subtotal: invoiceAmount
        },
        description: [
          'Storj.io Usage Charge - ',
          moment(billingCycle.startDate).format('MMM, DD'), ' - ',
          moment(billingCycle.endDate).format('MMM, DD')
        ].join('')
      }, (err, invoiceItem) => {
        if(err) console.log('ERROR ADDING TO STRIPE: ', err);
        console.log('Invoice item created: ', invoiceItem);
      });

    })
  })
  .catch((err) => {
    console.error(err);
    throw new Error(err);
  })

  res.sendStatus(200);
}


/**
 * Export definitions
 * @private
 */
 DebitsRouter.prototype._definitions = function() {
  return [
    ['POST', '/debits/sync', rawbody, this.verify, this.debitSync]
  ];
};

module.exports = DebitsRouter;