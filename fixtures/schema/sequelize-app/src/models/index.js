const { DataTypes } = require('sequelize');

const sequelize = require('../db');
const User = require('./user');
const Tag = require('./tag');
const Comment = require('./comment');
const Profile = require('./profile');
const BlogPost = require('./blog-post')(sequelize, DataTypes);

const models = { User, Tag, Comment, Profile, BlogPost };
BlogPost.associate(models);
User.hasMany(BlogPost, { as: 'posts', foreignKey: 'authorId' });
Comment.belongsTo(BlogPost);
User.hasOne(Profile);

module.exports = models;
