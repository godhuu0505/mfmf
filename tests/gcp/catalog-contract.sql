-- Schema-only evidence: no rows, identities, credentials or user content.
select jsonb_build_object(
 'tables',(select jsonb_object_agg(c.relname,jsonb_build_object('rls',c.relrowsecurity,'force',c.relforcerowsecurity))
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'),
 'columns',(select jsonb_object_agg(c.relname||'.'||a.attname,jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)))
   from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
   left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped),
 'constraints',(select jsonb_object_agg(c.relname||'.'||con.conname,pg_get_constraintdef(con.oid))
   from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'),
 'indexes',(select jsonb_object_agg(tablename||'.'||indexname,indexdef) from pg_indexes where schemaname='public'),
 'policies',(select jsonb_object_agg(tablename||'.'||policyname,jsonb_build_object('permissive',permissive,'roles',roles,'cmd',cmd,'using',qual,'check',with_check)) from pg_policies where schemaname='public'),
 'functions',(select jsonb_object_agg(p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',jsonb_build_object('body',p.prosrc,'definer',p.prosecdef,'config',p.proconfig,'return',pg_get_function_result(p.oid)))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
 'triggers',(select jsonb_object_agg(c.relname||'.'||t.tgname,pg_get_triggerdef(t.oid))
   from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','auth') and not t.tgisinternal)
);
