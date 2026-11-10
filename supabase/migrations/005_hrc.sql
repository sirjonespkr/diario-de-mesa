-- HRC: print do lobby separado dos prints da mão + resultados salvos para não gastar IA de novo.
-- Pode rodar mais de uma vez sem problema.

alter table hand_images add column if not exists kind text not null default 'mesa';
alter table hands add column if not exists hrc_payouts jsonb;
alter table hands add column if not exists hrc_table jsonb;
