import { Hono } from 'hono';
import { getBook, listBooks } from '../lib/handlers.ts';
import { BOOKS } from '../lib/paths.ts';

const books = new Hono();

books.get(BOOKS, listBooks);
books.get(`${BOOKS}/:id{[0-9]+}`, getBook);
books.get(`${BOOKS}/featured`, (c) => c.text('h:featured-books'));
books.post(BOOKS, async (c) => c.text('h:create-book'));
books.on(['PUT', 'PATCH'], `${BOOKS}/:id`, (c) => c.text('h:update-book'));

export default books;
