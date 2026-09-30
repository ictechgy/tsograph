import { Controller, Delete, Get } from '@nestjs/common';

@Controller('stats')
export class StatsController {
  @Get()
  stats() {
    return 'h:admin-stats';
  }

  @Delete('cache')
  clearCache() {
    return 'h:admin-clear-cache';
  }
}

@Controller({ path: 'reports', host: 'reports.example.com' })
export class ReportsController {
  @Get()
  reports() {
    return 'h:admin-reports';
  }
}

@Controller('unused')
export class UnusedController {
  @Get()
  unused() {
    return 'h:unused';
  }
}
