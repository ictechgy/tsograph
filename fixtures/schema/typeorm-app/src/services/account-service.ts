import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AppDataSource } from '../data-source.js';
import { UserAccount } from '../entities/account.js';
import { Order } from '../entities/order.js';

export class AccountService {
  constructor(@InjectRepository(UserAccount) private readonly accounts: Repository<UserAccount>) {}

  async findByEmail(email: string) {
    return this.accounts.findOne({
      where: { email, address: { postalCode: '00000' } },
      select: ['id', 'displayName'],
      relations: ['orders', 'groups', 'profile'],
    });
  }

  async ordersWithProducts(accountId: number) {
    return AppDataSource.getRepository(Order)
      .createQueryBuilder('o')
      .innerJoinAndSelect('o.product', 'p')
      .where('o.buyerId = :accountId', { accountId })
      .getMany();
  }

  async rename(id: number, displayName: string) {
    await AppDataSource.manager.update(UserAccount, { id }, { displayName });
    return AppDataSource.query('SELECT COUNT(*) FROM shop_orders');
  }
}
