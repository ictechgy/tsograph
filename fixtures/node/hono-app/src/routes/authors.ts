import { Hono } from 'hono';
import { PATHS } from '../lib/paths.ts';

export function createAuthors() {
  const authors = new Hono();
  authors.get(PATHS.authors, (c) => c.text('h:list-authors'));
  authors.get(`${PATHS.authors}/:name?`, (c) => c.text('h:author-optional'));
  return authors;
}
