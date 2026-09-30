const { DataTypes, Model } = require('sequelize');

const sequelize = require('../db');

class Comment extends Model {}

Comment.init({
  body: DataTypes.TEXT,
}, { sequelize, tableName: 'post_comments', createdAt: 'created', updatedAt: false, version: true });

module.exports = Comment;
