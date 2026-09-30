const { DataTypes } = require('sequelize');

const sequelize = require('../db');

const Tag = sequelize.define('Tag', {
  code: { type: DataTypes.STRING, primaryKey: true },
  label: DataTypes.STRING,
}, { freezeTableName: true, timestamps: false });

module.exports = Tag;
