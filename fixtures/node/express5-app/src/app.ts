import express from 'express';
import { catalog } from './routes/catalog.ts';
import { registerStatus } from './routes/register.ts';

const app = express();

app.get('/', (req, res) => { res.send('h:home'); });
app.use('/shop', catalog);
registerStatus(app, '/system');

const strictRouter = express.Router({ strict: true });
strictRouter.get('/exact/', (req, res) => { res.send('h:exact-slash'); });
app.use('/strict', strictRouter);

app.options('/cors-check', (req, res) => { res.send('h:cors-check'); });
app.get('/Mixed/Case', (req, res) => { res.send('h:mixed-case'); });

export default app;
