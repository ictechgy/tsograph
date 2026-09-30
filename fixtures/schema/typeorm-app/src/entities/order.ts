import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';

import type { UserAccount } from './account.js';
import { Product } from './product.js';

@Entity('orders')
export class Order {
  @PrimaryColumn('varchar')
  orderNo!: string;

  @Column('integer')
  total!: number;

  @ManyToOne('UserAccount', 'orders')
  buyer!: UserAccount;

  @ManyToOne(() => Product)
  @JoinColumn({ referencedColumnName: 'sku' })
  product!: Product;
}
