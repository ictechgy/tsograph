'use strict';

const { Router } = require('express');

const files = Router({ caseSensitive: true });

files.get('/Docs/:name', (req, res) => res.send('h:doc'));
files.get('/raw/*', (req, res) => res.send('h:raw'));
files.get('/pages/:page?', (req, res) => res.send('h:pages'));
files.get('/img-:id', (req, res) => res.send('h:image'));
files.get('/:name.:ext', (req, res) => res.send('h:named-file'));

exports.files = files;
