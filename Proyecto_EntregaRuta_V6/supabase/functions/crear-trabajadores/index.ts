import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const DOMINIO = 'trabajadores.entregaruta.demo'; // Igual que en index.html
const CONTRASENA_MIN = 8;
const RANGO_EMPRESA = 1000; // Cada empresa usa 1000 números: 2001 a 2999
const respuesta = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

    try {
        // 1. Quién llama: la sesión de la empresa (JWT del usuario)
        const userClient = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_ANON_KEY')!,
            { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } }
        );
        const { data: { user } } = await userClient.auth.getUser();
        if (!user) return respuesta({ error: 'No autorizado' }, 401);

        // 2. Cliente administrador (solo existe en el servidor)
        const admin = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
            { auth: { persistSession: false } }
        );

        const { data: empresa } = await admin
            .from('empresas').select('id, codigo').eq('id', user.id).maybeSingle();
        if (!empresa) return respuesta({ error: 'Solo una cuenta de empresa puede gestionar trabajadores' }, 403);

        const body = await req.json();

        // ----- DESACTIVAR (no se borra la cuenta: sus paquetes se conservan) -----
        if (body.accion === 'eliminar') {
            const { data: tr } = await admin.from('trabajadores')
                .select('auth_id')
                .eq('empresa_id', empresa.id)
                .eq('codigo_trabajador', body.codigo_trabajador)
                .maybeSingle();
            if (!tr) return respuesta({ error: 'Trabajador no encontrado' }, 404);

            const { error: errBan } = await admin.auth.admin.updateUserById(
                tr.auth_id, { ban_duration: '876000h' }
            );
            if (errBan) return respuesta({ error: errBan.message }, 500);

            const { error } = await admin.from('trabajadores')
                .update({ activo: false }).eq('auth_id', tr.auth_id);
            if (error) return respuesta({ error: error.message }, 500);
            return respuesta({ ok: true });
        }

        // ----- CREAR -----
        // Siguiente ID dentro de la empresa: 2001, 2002... (o el último asignado + 1)
        const { data: ultimo } = await admin.from('trabajadores')
            .select('codigo_trabajador')
            .eq('empresa_id', empresa.id)
            .order('codigo_trabajador', { ascending: false })
            .limit(1)
            .maybeSingle();
        let siguienteId = ultimo ? ultimo.codigo_trabajador + 1 : empresa.codigo + 1;
        const limiteId = empresa.codigo + RANGO_EMPRESA - 1;

        const resultados: Array<Record<string, unknown>> = [];
        for (const t of body.trabajadores ?? []) {
            const usuario = String(t.usuario ?? '').trim().toLowerCase();
            if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) {
                resultados.push({ usuario, ok: false, error: 'Usuario inválido (3-30 caracteres: letras, números, . _ -)' });
                continue;
            }

            const contrasena = String(t.contrasena ?? '');
            if (contrasena.length < CONTRASENA_MIN) {
                resultados.push({ usuario, ok: false, error: `La contraseña debe tener al menos ${CONTRASENA_MIN} caracteres` });
                continue;
            }

            if (siguienteId > limiteId) {
                resultados.push({ usuario, ok: false, error: 'La empresa alcanzó el límite de 999 trabajadores' });
                continue;
            }

            const email = `${empresa.codigo}.${usuario}@${DOMINIO}`;

            const { data: creado, error: errAuth } = await admin.auth.admin.createUser({
                email,
                password: contrasena,
                email_confirm: true,
                user_metadata: { usuario },
            });
            if (errAuth) {
                resultados.push({ usuario, ok: false, error: errAuth.message });
                continue;
            }

            const { error: errFila } = await admin.from('trabajadores').insert({
                codigo_trabajador: siguienteId,
                auth_id: creado.user.id,
                empresa_id: empresa.id,
                codigo_empresa: empresa.codigo,
                nombre: t.nombre ?? '',
                usuario,
                correo: t.correo || null,
                telefono: t.telefono || null,
                debe_cambiar_password: true,
            });
            if (errFila) {
                await admin.auth.admin.deleteUser(creado.user.id);
                resultados.push({ usuario, ok: false, error: errFila.message });
                continue;
            }

            siguienteId++;
            resultados.push({ usuario, ok: true, id_trabajador: siguienteId - 1 });
        }

        return respuesta({ resultados });
    } catch (e) {
        return respuesta({ error: String(e) }, 500);
    }
});