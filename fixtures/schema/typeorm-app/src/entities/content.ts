import { ChildEntity, Column, Entity, PrimaryGeneratedColumn, TableInheritance } from 'typeorm';

@Entity()
@TableInheritance({ column: { type: 'varchar', name: 'kind' } })
export class Content {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column('varchar')
  title!: string;
}

@ChildEntity()
export class Article extends Content {
  @Column('text')
  body!: string;
}
