const { DataTypes, Model } = require('sequelize');

const sequelize = require('../db');

class Profile extends Model {}

Profile.init({ bio: DataTypes.TEXT }, { sequelize, underscored: false, modelName: 'Profile' });

module.exports = Profile;
