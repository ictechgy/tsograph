'use strict';

const express = require('express');

const admin = express();
admin.enable('strict routing');
admin.get('/panel', (req, res) => res.send('h:admin-panel'));
admin.get('/panel/', (req, res) => res.send('h:admin-panel-slash'));

module.exports = admin;
