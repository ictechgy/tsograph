import type { Express, Request, Response } from 'express';

export function registerStatus(app: Express, prefix: string) {
  app.get(`${prefix}/status`, (req: Request, res: Response) => { res.send('h:status'); });
  app.head(`${prefix}/status`, (req: Request, res: Response) => { res.send('h:status-head'); });
}
