import express from 'express';
import { Pool } from 'pg';

import { asyncHandler } from './async-handler';

const pool = new Pool();
const app = express();

// 감싼 인라인 핸들러: id는 감싼 함수가 아니라 등록 호출(`app.get("/orders")`)에서 온다.
app.get('/orders', asyncHandler(async (request, response) => {
  const result = await pool.query('SELECT id FROM orders');
  response.json(result.rows);
}));

app.delete('/orders/:id', async (request, response) => {
  await pool.query('DELETE FROM order_items WHERE order_id = $1', [request.params.id]);
  response.sendStatus(204);
});

const router = express.Router();
router.get('/customers', function (request, response, next) {
  pool.query('SELECT id FROM customers').then((result) => response.json(result.rows), next);
});
app.use('/api', router);

export default app;
