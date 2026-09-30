import { Hono } from 'hono';

const app = new Hono({ strict: false }).basePath('/api');

app.get('/', (c) => c.text('h:api-root'));
app.get('/items', (c) => c.text('h:items'));
app.get('/items/', (c) => c.text('h:items-slash'));
app.post('/Items/:id', (c) => c.text('h:item-post'));

export default app;
