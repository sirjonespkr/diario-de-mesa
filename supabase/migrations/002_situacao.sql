-- Adiciona o campo "Situação" (preenchido pela IA) nas mãos.
alter table hands add column if not exists situation text;
