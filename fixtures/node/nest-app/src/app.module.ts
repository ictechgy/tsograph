import { Controller, Get, Module, VERSION_NEUTRAL } from '@nestjs/common';
import { RouterModule } from '@nestjs/core';
import { AdminModule } from './admin/admin.module.js';
import { UsersModule } from './users/users.module.js';

@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  @Get()
  health() {
    return 'h:health';
  }
}

@Module({
  imports: [UsersModule, AdminModule, RouterModule.register([{ path: 'admin', module: AdminModule }])],
  controllers: [HealthController],
})
export class AppModule {}
