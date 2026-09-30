const sequelize = require('./db');
const { BlogPost, Comment, Tag, User } = require('./models');

async function recentPosts(email) {
  return BlogPost.findAll({
    where: { title: 'hello' },
    attributes: ['id', 'title', ['published_on', 'published']],
    include: [{ model: User, as: 'author', where: { email } }, Tag],
  });
}

async function addComment(postId, body) {
  return Comment.create({ body, BlogPostId: postId });
}

async function renameUser(id, firstName) {
  await User.update({ firstName }, { where: { id } });
  return sequelize.query('select count(*) from users');
}

module.exports = { recentPosts, addComment, renameUser };
