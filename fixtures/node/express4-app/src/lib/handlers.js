'use strict';

function listOrders(req, res) {
  res.send('h:list-orders');
}

const getOrder = (req, res) => res.send('h:get-order');

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { listOrders, getOrder, asyncHandler };
