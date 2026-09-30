import { Module } from '@nestjs/common';
import { ReportsController, StatsController } from './admin.controller.js';

@Module({ controllers: [StatsController, ReportsController] })
export class AdminModule {}
