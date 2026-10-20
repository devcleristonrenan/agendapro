// AgendaPro — Edge Function: send-invite
// Envia um e-mail de convite para o cliente com o link de acesso à agenda.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";

interface InvitePayload {
  clientEmail: string;
  clientName: string;
  inviteLink: string;
  ownerEmail?: string;
}

serve(async (req: Request) => {
  // Permite chamadas cross-origin do frontend
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  try {
    const { clientEmail, clientName, inviteLink, ownerEmail }: InvitePayload =
      await req.json();

    if (!clientEmail || !inviteLink) {
      return new Response(
        JSON.stringify({ error: "clientEmail e inviteLink são obrigatórios." }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    const firstName = clientName ? clientName.split(" ")[0] : "Cliente";

    const htmlBody = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Convite AgendaPro</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:Inter,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08);">

          <!-- Header -->
          <tr>
            <td style="background:#18181b;padding:28px 36px;text-align:center;">
              <span style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-1px;">
                Agenda<span style="color:#a78bfa;">Pro</span>
              </span>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 36px 28px;">
              <p style="margin:0 0 8px;color:#71717a;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;">
                SEU CONVITE CHEGOU 🎉
              </p>
              <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#18181b;line-height:1.3;">
                Olá, ${firstName}!
              </h1>
              <p style="margin:0 0 24px;font-size:15px;color:#52525b;line-height:1.6;">
                Você foi convidado(a) para acessar a agenda online.
                Crie sua conta gratuitamente e agende seus horários com praticidade — a qualquer hora, pelo celular ou computador.
              </p>

              <!-- CTA button -->
              <table cellpadding="0" cellspacing="0" style="margin:0 auto 28px;">
                <tr>
                  <td style="background:#7c3aed;border-radius:8px;">
                    <a href="${inviteLink}"
                       style="display:block;padding:14px 32px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;letter-spacing:.01em;">
                      Criar minha conta →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 8px;font-size:13px;color:#a1a1aa;line-height:1.5;">
                Ou copie e cole o link no seu navegador:
              </p>
              <p style="margin:0;font-size:12px;color:#7c3aed;word-break:break-all;background:#f4f3ff;border-radius:6px;padding:10px 12px;">
                ${inviteLink}
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 36px;border-top:1px solid #f4f4f5;text-align:center;">
              <p style="margin:0;font-size:12px;color:#a1a1aa;">
                AgendaPro · Organize seu trabalho com simplicidade.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "AgendaPro <onboarding@resend.dev>",
        to: [clientEmail],
        subject: "🎉 Você foi convidado para a AgendaPro!",
        html: htmlBody,
      }),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      return new Response(
        JSON.stringify({ error: "Falha ao enviar e-mail.", detail: errorBody }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Erro interno.", detail: String(err) }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
});
