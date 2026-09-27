-- 합성 마이그레이션: fixture 스키마와 같은 PostgreSQL 카탈로그를 만든다.
CREATE TYPE "Genre" AS ENUM ('FICTION', 'ESSAY');

CREATE TABLE "authors" (
    "id" SERIAL NOT NULL,
    "full_name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "authors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Book" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "genre" "Genre" NOT NULL,
    "authorId" INTEGER NOT NULL,
    "legacy" TEXT,
    "search" tsvector,
    CONSTRAINT "Book_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Tag" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ImportBatch" (
    "id" INTEGER NOT NULL,
    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "_BookToTag" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,
    CONSTRAINT "_BookToTag_AB_pkey" PRIMARY KEY ("A", "B")
);

CREATE UNIQUE INDEX "Tag_label_key" ON "Tag"("label");
CREATE INDEX "_BookToTag_B_index" ON "_BookToTag"("B");

ALTER TABLE "Book" ADD CONSTRAINT "Book_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "authors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "_BookToTag" ADD CONSTRAINT "_BookToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Book"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "_BookToTag" ADD CONSTRAINT "_BookToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
