'use strict';

const express = require('express');
const cors = require('cors');
const orders = require('./routes/orders');
const { files } = require('./routes/files');
const admin = require('./admin');

const app = express();
const API = '/api';

app.use(cors());
app.use(express.json());
app.use('/assets', express.static('public'));

app.get('/', (req, res) => res.send('h:home'));

// 먼저 등록한 핸들러가 next()로 넘기면 뒤의 등록이 받는다.
app.get('/users/:id', (req, res, next) => {
  if (req.params.id === 'me') return next();
  res.send('h:user-by-id');
});
app.get('/users/me', (req, res) => res.send('h:user-me'));

// next가 없는 핸들러는 뒤의 같은 경로를 가린다.
app.get('/shadow/:x', (req, res) => res.send('h:shadow-param'));
app.get('/shadow/fixed', (req, res) => res.send('h:shadow-fixed'));

app.all('/any', (req, res) => res.send('h:any'));
app.post('/Case/Path', (req, res) => res.send('h:case-path'));

app.use(API + '/orders', orders);
app.use('/files', files);
app.use('/admin', admin);

app.use('/health', (req, res) => res.send('h:health'));

if (process.env.LEGACY === '1') {
  app.get('/legacy', (req, res) => res.send('h:legacy'));
}

const version = process.env.API_VERSION;
app.get('/v' + version + '/status', (req, res) => res.send('h:versioned-status'));

app.use((req, res) => {
  res.status(404).send('not found');
});

app.use((err, req, res, next) => {
  res.status(500).send('error');
});

module.exports = app;
