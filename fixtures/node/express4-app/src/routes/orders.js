'use strict';

const express = require('express');
const { listOrders, getOrder, asyncHandler } = require('../lib/handlers');

const router = express.Router();

router.get('/', listOrders);
router.get('/:id(\\d+)', getOrder);
router.post('/', asyncHandler(async (req, res) => {
  res.send('h:create-order');
}));
router.route('/:id(\\d+)/items')
  .get((req, res) => res.send('h:order-items'))
  .put((req, res) => res.send('h:replace-items'));

module.exports = router;
