const { Sequelize } = require('sequelize');

// 모든 모델에 적용되는 전역 옵션이다.
const sequelize = new Sequelize('sqlite::memory:', { logging: false, define: { underscored: true } });

module.exports = sequelize;
