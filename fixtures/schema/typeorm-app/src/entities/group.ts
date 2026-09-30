import { Column, Entity, JoinTable, ManyToMany, PrimaryGeneratedColumn } from 'typeorm';

import type { UserAccount } from './account.js';

@Entity({ name: 'groups' })
export class Group {
  @PrimaryGeneratedColumn('uuid')
  groupId!: string;

  @Column('varchar')
  name!: string;

  @ManyToMany('UserAccount', 'groups')
  members!: UserAccount[];

  @ManyToMany(() => Group)
  @JoinTable()
  related!: Group[];
}
