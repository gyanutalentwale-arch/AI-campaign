function findEmailColumn(headers = []) {
  return headers.find((h) => /email|mail/i.test(h));
}

module.exports = function createEmailController(ctx) {
  return {
    parseFile(req, res) {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });
      try {
        const { contacts, headers, emailCol } = ctx.parseEmailContactsFile(
          req.file.buffer,
          req.file.mimetype,
          req.file.originalname,
        );
        if (!contacts.length) {
          return res.status(400).json({
            error: `No valid email contacts found. Columns detected: [${headers.join(", ")}]. Need an email/mail column.`,
          });
        }
        res.json({ contacts, headers, total: contacts.length, emailCol });
      } catch (e) {
        res.status(500).json({ error: "Parse error: " + e.message });
      }
    },

    async parseSheet(req, res) {
      const { url } = req.body;
      if (!url) return res.status(400).json({ error: "URL required" });
      try {
        const csvUrl = ctx.getGoogleSheetCsvUrl(url);
        const response = await ctx.axios.get(csvUrl, {
          responseType: "arraybuffer",
          timeout: 10000,
        });
        const buffer = Buffer.from(response.data);
        const { contacts, headers, emailCol } = ctx.parseEmailContactsFile(
          buffer,
          "text/csv",
          "sheet.csv",
        );
        if (!contacts.length) {
          return res.status(400).json({
            error: `No valid email contacts found. Columns detected: [${headers.join(", ")}]. Need an email/mail column.`,
          });
        }
        res.json({ contacts, headers, total: contacts.length, emailCol });
      } catch (e) {
        const msg =
          e.response?.status === 403
            ? 'Sheet is private. Share it as "Anyone with the link can view".'
            : "Fetch error: " + e.message;
        res.status(500).json({ error: msg });
      }
    },

    async testAccounts(req, res) {
      ctx.syncEmailAccountsFromEnv();
      const emailAccounts = ctx.getEmailAccounts();
      if (!emailAccounts.length) {
        return res.status(400).json({
          ok: false,
          msg: "No email accounts configured in .env (EMAIL_1_USER, EMAIL_1_PASSWORD, etc.)",
        });
      }

      const results = [];
      for (const acc of emailAccounts) {
        const provider = ctx.getEmailProviderLimitInfo(acc.user);
        try {
          const transporter = ctx.makeTransporter(acc);
          await transporter.verify();
          results.push({
            user: acc.user,
            ok: true,
            sent: acc.dailySent,
            configuredLimit: ctx.DAILY_LIMIT,
            estimatedOriginalLimit: provider.estimatedDailyLimit,
            limitSource: provider.source,
            limitNote: provider.note,
            exactLimitAvailable: provider.exactAvailable,
            remainingToday: Math.max(
              ctx.DAILY_LIMIT - (acc.dailySent || 0),
              0,
            ),
          });
        } catch (e) {
          results.push({
            user: acc.user,
            ok: false,
            error: e.message,
            configuredLimit: ctx.DAILY_LIMIT,
            estimatedOriginalLimit: provider.estimatedDailyLimit,
            limitSource: provider.source,
            limitNote: provider.note,
            exactLimitAvailable: provider.exactAvailable,
            remainingToday: Math.max(
              ctx.DAILY_LIMIT - (acc.dailySent || 0),
              0,
            ),
          });
        }
      }

      const allOk = results.every((r) => r.ok);
      res.json({
        ok: allOk,
        exactLimitAvailable: false,
        note: "SMTP does not expose exact daily quota or remaining sends. Provider limit here is an estimate.",
        results,
      });
    },

    listAccounts(req, res) {
      ctx.syncEmailAccountsFromEnv();
      const emailAccounts = ctx.getEmailAccounts();
      const activeAccountIdx = ctx.getActiveAccountIdx();
      res.json({
        accounts: emailAccounts.map((a, i) => ({
          index: i,
          user: a.user,
          name: a.name,
          dailySent: a.dailySent || 0,
          limit: ctx.DAILY_LIMIT,
          remainingToday: Math.max(ctx.DAILY_LIMIT - (a.dailySent || 0), 0),
          totalSent: a.totalSent || 0,
          totalFailed: a.totalFailed || 0,
          active: i === activeAccountIdx,
        })),
      });
    },

    getPreset(req, res) {
      res.json({ preset: ctx.loadEmailPreset() });
    },

    savePreset(req, res) {
      try {
        const preset = ctx.saveEmailPreset(req.body || {});
        res.json({ ok: true, preset });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },

    async startCampaign(req, res) {
      const { contacts, subject, template, delayMs } = req.body;
      if (!contacts?.length || !subject || !template) {
        return res
          .status(400)
          .json({ error: "contacts, subject and template required" });
      }

      try {
        ctx.saveEmailPreset({
          subject,
          template,
          delaySec: Math.max(
            Math.round((parseInt(delayMs, 10) || 5000) / 1000),
            1,
          ),
        });
      } catch (e) {
        ctx.addLog("warn", `Could not save email preset: ${e.message}`);
      }

      ctx.syncEmailAccountsFromEnv();
      if (!ctx.getEmailAccounts().length) {
        return res.status(400).json({
          error:
            "No email accounts configured. Add EMAIL_1_USER / EMAIL_1_PASSWORD to .env",
        });
      }

      const id = Date.now().toString();
      const campaign = {
        id,
        status: "running",
        total: contacts.length,
        sent: 0,
        failed: 0,
        log: [],
      };
      ctx.emailCampaigns.set(id, campaign);
      res.json({ id });

      const delay = Math.max(parseInt(delayMs, 10) || 3000, 1000);

      for (const contact of contacts) {
        if (campaign.status === "stopped") break;

        const headers = Object.keys(contact);
        const emailKey = findEmailColumn(headers);
        const to = emailKey ? contact[emailKey] : "";

        const validation = await ctx.isValidEmail(to);
        if (!validation.valid) {
          campaign.failed++;
          ctx.recordEmailFailure();
          campaign.log.push({
            ...contact,
            _status: "skipped",
            _error: validation.reason,
          });
          ctx.addLog("warn", `Skipped ${to} - ${validation.reason}`);
          ctx.io.emit("email_progress", {
            id,
            sent: campaign.sent,
            failed: campaign.failed,
            total: campaign.total,
          });
          ctx.refreshEmailStats();
          continue;
        }

        const acc = ctx.getActiveAccount();
        if (!acc) {
          ctx.addLog(
            "error",
            `All email accounts hit daily limit (${ctx.DAILY_LIMIT}/day). Stopping campaign.`,
          );
          campaign.status = "stopped";
          ctx.refreshEmailStats();
          break;
        }

        try {
          const body = ctx.fillTpl(template, contact);
          const subjectFilled = ctx.fillTpl(subject, contact);
          const transporter = ctx.makeTransporter(acc);

          await transporter.sendMail({
            from: `"${acc.name}" <${acc.user}>`,
            to,
            subject: subjectFilled,
            html: body,
            text: body.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim(),
          });

          ctx.recordEmailSend(acc);
          campaign.sent++;
          campaign.log.push({ ...contact, _status: "sent", _account: acc.user });
          ctx.addLog(
            "success",
            `Sent -> ${to} via ${acc.user} (${campaign.sent}/${campaign.total}, today: ${acc.dailySent}/${ctx.DAILY_LIMIT})`,
          );

          if (acc.dailySent >= ctx.DAILY_LIMIT) {
            ctx.addLog(
              "warn",
              `${acc.user} hit daily limit. Switching to next account...`,
            );
            const accounts = ctx.getEmailAccounts();
            if (accounts.length) {
              const nextIdx =
                (ctx.getActiveAccountIdx() + 1) % accounts.length;
              ctx.setActiveAccountIdx(nextIdx);
              ctx.saveEmailUsageState();
            }
          }
        } catch (e) {
          campaign.failed++;
          ctx.recordEmailFailure(acc);
          campaign.log.push({
            ...contact,
            _status: "failed",
            _error: e.message,
            _account: acc.user,
          });
          ctx.addLog("error", `Email failed -> ${to}: ${e.message}`);
        }

        ctx.refreshEmailStats();
        ctx.io.emit("email_progress", {
          id,
          sent: campaign.sent,
          failed: campaign.failed,
          total: campaign.total,
          activeAccount: acc.user,
          accountSent: acc.dailySent,
          accountLimit: ctx.DAILY_LIMIT,
        });

        const isLast = campaign.sent + campaign.failed >= campaign.total;
        if (!isLast && campaign.status !== "stopped") {
          const wait = delay + Math.floor(Math.random() * 2000);
          ctx.addLog("info", `Next email in ${(wait / 1000).toFixed(1)}s...`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      campaign.status = campaign.status === "stopped" ? "stopped" : "done";
      ctx.io.emit("email_progress", {
        id,
        sent: campaign.sent,
        failed: campaign.failed,
        total: campaign.total,
        status: campaign.status,
      });
      ctx.refreshEmailStats();
      ctx.addLog(
        "info",
        `Email campaign done - Sent: ${campaign.sent}, Failed: ${campaign.failed}`,
      );
    },

    stopCampaign(req, res) {
      const campaign = ctx.emailCampaigns.get(req.params.id);
      if (campaign) campaign.status = "stopped";
      res.json({ ok: true });
    },

    downloadLog(req, res) {
      const campaign = ctx.emailCampaigns.get(req.params.id);
      if (!campaign || !campaign.log.length) {
        return res.status(404).json({ error: "Not found" });
      }
      const headers = [...new Set(campaign.log.flatMap((r) => Object.keys(r)))];
      const csv = [
        headers.join(","),
        ...campaign.log.map((r) =>
          headers
            .map((h) => `"${(r[h] || "").toString().replace(/"/g, '""')}"`)
            .join(","),
        ),
      ].join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="email_${req.params.id}.csv"`,
      );
      res.send("\uFEFF" + csv);
    },
  };
};
