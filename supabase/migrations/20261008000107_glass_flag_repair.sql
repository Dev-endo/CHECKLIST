-- Conserto de dados: aparelhos que já voltaram do vidro antes da migration 101 ficaram com a marca "vidro e outra
-- manutenção" (needs_glass) e só conseguiam finalizar para o Vidro. Zera a marca nos checklists em andamento cujo
-- vidro já foi concluído e que não têm vidro aberto. Pode rodar mais de uma vez.

update public.repair_stages s
   set needs_glass = false
 where s.stage = 'manutencao'
   and s.needs_glass
   and s.status <> 'concluida'
   and exists (
     select 1 from public.repair_glass_jobs j
      where j.os_id = s.os_id and j.status = 'concluido'
   )
   and not exists (
     select 1 from public.repair_glass_jobs j
      where j.os_id = s.os_id and j.status <> 'concluido'
   );

notify pgrst, 'reload schema';
