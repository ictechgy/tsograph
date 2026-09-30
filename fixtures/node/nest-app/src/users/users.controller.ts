import { All, Controller, Get, Next, Param, Post, Put, Version } from '@nestjs/common';

@Controller('users')
export class UsersController {
  @Get()
  list() {
    return 'h:list-users';
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return 'h:find-user';
  }

  // 먼저 등록한 ':id'가 이 경로를 가린다(Express 첫 매치).
  @Get('me')
  me() {
    return 'h:user-me';
  }

  @Post()
  create() {
    return 'h:create-user';
  }

  @Put(':id')
  @Version('2')
  replace() {
    return 'h:replace-user-v2';
  }

  @All('any')
  any() {
    return 'h:users-any';
  }

  @Get('files/*')
  files() {
    return 'h:user-files';
  }

  @Get('delegate')
  delegate(@Next() next: () => void) {
    next();
  }
}
