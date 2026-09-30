import { DataSource } from 'typeorm';

import { UserAccount } from './entities/account.js';
import { Article, Content } from './entities/content.js';
import { Group } from './entities/group.js';
import { Order } from './entities/order.js';
import { Product } from './entities/product.js';
import { Profile } from './entities/profile.js';

/** 이름에 영향을 주는 옵션이다(오라클이 같은 값으로 SQLite에 동기화한다). */
export const dataSourceOptions = { type: 'postgres' as const, entityPrefix: 'shop_' };

/** 모든 엔터티다. */
export const entities = [UserAccount, Profile, Product, Order, Group, Content, Article];

export const AppDataSource = new DataSource({ ...dataSourceOptions, entities });
