import { AppDataSource } from '../data-source.js';
import { Group } from '../entities/group.js';
import { Article } from '../entities/content.js';

export async function relatedGroups(groupId: string) {
  const groups = AppDataSource.getRepository(Group);
  return groups.find({ where: { groupId }, relations: { related: true, members: true } });
}

export async function publish(title: string) {
  return AppDataSource.transaction(async (manager) => manager.insert(Article, { title, body: '' }));
}
