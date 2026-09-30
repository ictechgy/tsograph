import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
export class Product {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column('varchar', { unique: true })
  sku!: string;

  @Column('varchar')
  title!: string;
}
