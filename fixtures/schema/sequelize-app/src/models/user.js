const { DataTypes, Model } = require('sequelize');

const sequelize = require('../db');

class User extends Model {}

User.init({
  firstName: DataTypes.STRING,
  lastName: { type: DataTypes.STRING, allowNull: false },
  email: { type: DataTypes.STRING, field: 'email_address' },
  fullName: { type: DataTypes.VIRTUAL, get() { return `${this.firstName} ${this.lastName}`; } },
}, { sequelize, modelName: 'User' });

module.exports = User;
