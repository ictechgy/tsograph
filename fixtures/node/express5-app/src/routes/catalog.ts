import { Router, type Request, type Response } from 'express';

export const catalog = Router();

catalog.get('/products', (req: Request, res: Response) => { res.send('h:list-products'); });
catalog.get('/products/:id', (req: Request, res: Response) => { res.send('h:get-product'); });
catalog.get('/files/*path', (req: Request, res: Response) => { res.send('h:catalog-files'); });
catalog.get('/list{/:page}', (req: Request, res: Response) => { res.send('h:catalog-list'); });
catalog.get('/export.:format', (req: Request, res: Response) => { res.send('h:catalog-export'); });
catalog.route('/tags/:tag')
  .get((req: Request, res: Response) => { res.send('h:get-tag'); })
  .delete((req: Request, res: Response) => { res.send('h:delete-tag'); });
