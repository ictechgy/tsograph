// sequelize-cli 모양의 모델 정의다.
module.exports = (sequelize, DataTypes) => {
  const BlogPost = sequelize.define('BlogPost', {
    title: DataTypes.STRING,
    publishedAt: { type: DataTypes.DATE, field: 'published_on' },
  }, { paranoid: true });

  BlogPost.associate = function (models) {
    BlogPost.belongsTo(models.User, { as: 'author' });
    BlogPost.belongsToMany(models.Tag, { through: 'PostTags' });
  };

  return BlogPost;
};
