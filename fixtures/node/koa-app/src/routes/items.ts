import type { Context } from 'koa';

export async function listItems(ctx: Context) {
  ctx.body = 'h:list-items';
}

export const getItem = (ctx: Context) => {
  ctx.body = 'h:get-item';
};
