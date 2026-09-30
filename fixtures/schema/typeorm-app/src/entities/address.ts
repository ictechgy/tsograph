import { Column } from 'typeorm';

/** 좌표 임베디드다. */
export class Geo {
  @Column('real')
  lat!: number;

  @Column('real')
  lng!: number;
}

/** 주소 임베디드다. */
export class Address {
  @Column('varchar')
  street!: string;

  @Column('varchar', { name: 'ZIP' })
  postalCode!: string;

  @Column(() => Geo, { prefix: 'geo' })
  location!: Geo;
}
