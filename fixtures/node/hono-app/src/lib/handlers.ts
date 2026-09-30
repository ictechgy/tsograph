import type { Context } from 'hono';

export function listBooks(c: Context) {
  return c.text('h:list-books');
}

export const getBook = (c: Context) => c.text('h:get-book');

export const handlers = {
  health: (c: Context) => c.text('h:health'),
};
