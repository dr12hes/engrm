# Sustainability

## How "Free Forever" Works

**TL;DR:** Free tier is genuinely free. We make money from paid tiers, not by baiting and switching.

---

## Economics

### Free Tier Cost Breakdown

**Per user (2 devices, 5,000 observations):**

| Cost Item | Monthly | Annual | Notes |
|-----------|---------|--------|-------|
| Cloud storage | ~£0.05 | ~£0.60 | SQLite replica on S3-compatible storage |
| Sync bandwidth | ~£0.02 | ~£0.24 | Cursor-based deltas, not full syncs |
| Embeddings (BGE-M3) | £0.00 | £0.00 | Local all-MiniLM-L6-v2, cloud cached |
| Search compute | ~£0.01 | ~£0.12 | pgvector on shared Postgres |
| **Total per free user** | **~£0.08** | **~£0.96** |

**Break-even:** Free users cost ~£1/year. If 1 in 20 free users upgrades to Vibe (£5.99/mo), we're profitable.

---

## Revenue Model

### What We Charge For

| Tier | Price | What You Pay For |
|------|-------|------------------|
| **Free** | £0 | Community tier. We subsidize this. |
| **Vibe** | £5.99/mo | Delivery Review + Sentinel advisory (actual compute cost) |
| **Pro** | £9.99/mo | Higher volume + longer retention (storage cost) |
| **Team** | £12.99/seat | Shared namespace infra + Sentinel blocking (heavy LLM cost) |

### Cost Centers (Paid Plans)

- **Sentinel blocking mode (Team):** ~£0.10-0.30 per audit (Claude API)
- **Delivery Review (Vibe+):** ~£0.05 per session (structured extraction)
- **Team sync infra:** Dedicated namespace, higher write throughput

**Margins:**
- Vibe: ~70% margin after compute
- Pro: ~75% margin (storage is cheap)
- Team: ~60% margin (Sentinel blocking is expensive)

---

## Why Free Tier Stays Free

1. **Marketing:** Free users drive word-of-mouth. Every free user is a potential advocate.
2. **Network effects:** More users = more knowledge packs + community patterns
3. **Fair Source ethos:** We believe in free access to core functionality
4. **Long-term play:** Today's free user is tomorrow's paying team

### What Would Force a Change

We'd only restrict the free tier if:
- Storage costs 10x unexpectedly (unlikely with scale)
- Abuse (crypto mining, spam, etc.) becomes unsustainable
- Regulatory compliance costs spike (GDPR audits, SOC 2)

**If that happens:** Grandfather existing free users. New signups get a trial, then convert.

---

## Self-Hosting Option

Don't trust us? **Run your own Candengo Vector instance.**

```bash
npx engrm init --url=https://vector.internal.company.com
```

You pay for your own infrastructure. Engrm (the client) remains open-source (FSL-1.1-ALv2).

---

## Open Questions

**Q: What if you get acquired?**  
A: FSL-1.1-ALv2 license means code converts to Apache 2.0 after 2 years. Community can fork.

**Q: What if you shut down?**  
A: Export script will dump your data to JSON. You own your observations.

**Q: What if you raise VC and need 10x growth?**  
A: We're bootstrapped. No VC pressure. If that changes, we'll communicate 6+ months in advance.

---

## Transparency Commitment

We'll publish:
- Quarterly: Rough user counts per tier (anonymized)
- Annually: Cost structure updates if economics shift
- Always: 30 days notice before any free tier changes

Last updated: March 18, 2026
