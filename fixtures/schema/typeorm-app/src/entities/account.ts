import { Column, Entity, JoinColumn, JoinTable, ManyToMany, OneToMany, OneToOne } from 'typeorm';

import { Address } from './address.js';
import { Base } from './base.js';
import { Group } from './group.js';
import { Order } from './order.js';
import { Profile } from './profile.js';

@Entity()
export class UserAccount extends Base {
  @Column('varchar')
  displayName!: string;

  @Column('varchar', { name: 'email_address' })
  email!: string;

  @Column(() => Address)
  address!: Address;

  @OneToMany(() => Order, (order) => order.buyer)
  orders!: Order[];

  @ManyToMany(() => Group, (group) => group.members)
  @JoinTable()
  groups!: Group[];

  @OneToOne(() => Profile)
  @JoinColumn({ name: 'profile_ref' })
  profile!: Profile;
}
