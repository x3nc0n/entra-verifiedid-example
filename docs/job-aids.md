# Job Aids

Practical, step-by-step guides for the three roles that touch this pilot:
the **Admin** who owns the pilot's Azure/Entra configuration, the **Manager**
who approves each request, and the **User** who completes it. Each role has a
guide for both flows the portal supports today:

- **Onboarding** — a brand-new pilot user registers their first passkey.
- **Account Recovery** — an existing pilot user who lost every passkey gets a
  fresh one after their old ones are revoked.

These are task guides, not architecture docs. For how the system works under
the hood, see [`docs/architecture.md`](architecture.md). For configuration
reference, see the main [`README.md`](../README.md).

---

## 1. Admin job aid

The Admin is responsible for the one-time and ongoing configuration that
Managers and Users depend on. The Admin does not approve individual requests.

### 1.1 One-time setup (before the first real pilot user)

1. **Confirm the pilot group.** `PILOT_GROUP_ID` must point to the dedicated
   security group (e.g. `sg-entra-verifiedid-pilot`). Both onboarding and
   recovery re-check transitive membership in this group immediately before
   issuing a TAP — a user outside the group cannot be onboarded or recovered
   no matter what the Manager submits.
2. **Add pilot users to the group.** Membership is the actual authorization
   gate. Adding someone to `sg-entra-verifiedid-pilot` is what makes them
   eligible; the portal does not have its own separate user allowlist.
3. **Set the two Key Vault secrets** referenced by the `Deploy` workflow:
   `session-secret` and `onboarding-approval-key`. The approval key is shared
   by **both** `POST /api/invitations` (onboarding) and
   `POST /api/recovery-requests` (recovery) — there is only one key to
   distribute to the Manager's approval tooling.
4. **Confirm the runtime managed identity's Graph app roles**:
   `User.Read.All`, `GroupMember.Read.All`, and
   `UserAuthenticationMethod.ReadWrite.All` (needed for recovery's passkey
   revocation as well as TAP/FIDO2 registration). Run
   `scripts/08-grant-app-uami-graph-permissions.ps1` if not already applied.
5. **Confirm `Storage Table Data Contributor`** on the invitation and session
   tables only (least privilege). Recovery does not use a separate table — it
   reuses the invitation table under a different partition key, so no extra
   grant is needed for recovery specifically.

### 1.2 Ongoing responsibilities

| Task | How |
|---|---|
| Rotate the approval key | Update `onboarding-approval-key` in Key Vault; redeploy so the Container App picks up the new secret. Both onboarding and recovery approval calls stop working with the old key immediately. |
| Add/remove pilot users | Add or remove membership in `sg-entra-verifiedid-pilot` directly in Entra. Takes effect on the *next* invitation/recovery attempt (checked live, not cached). |
| Investigate a stuck request | Check Container App logs for the request's `entraUserId` — the app never logs the raw token, TAP value, or evidence values, only outcomes (created / consumed / expired / locked / revoked-methods count). |
| Confirm a recovery actually revoked old passkeys | Query `GET /users/{id}/authentication/fido2Methods` via Graph for the affected user — it should show only the method(s) registered after the recovery TAP was issued. |

### 1.3 What the Admin should never do

- Never expose `POST /api/invitations` or `POST /api/recovery-requests`
  directly to a browser or to Users — both require the approval key and are
  meant to be called only from the Manager's approved workflow/tooling.
- Never enable `ASSURANCE_MODE=verified-id` until a partner contract and
  durable callback-correlation store are in place (see README).

---

## 2. Manager job aid

The Manager is the human (or approved workflow) that decides *who* gets an
onboarding invitation or a recovery request, and supplies the evidence the
User will be asked to confirm.

### 2.1 Approving a new onboarding (first-time user)

1. Confirm the person is a legitimate pilot participant and is already a
   member of the pilot security group (ask the Admin if unsure).
2. Call `POST /api/invitations` with:
   - `entraUserId` — the user's **immutable Entra object ID** (not their UPN
     or display name).
   - `personalEmail` — the known personal email you will deliver the link to.
   - `employeeId` — the employee identifier the user will be asked to type
     back to prove they received the link at the right address.
   - Header `x-onboarding-approval-key: <the shared approval key>`.
3. The response contains a one-time `invitationUrl`. **This is the only time
   it is returned** — the portal never logs or re-displays it.
4. Deliver the URL to the user's personal email through your approved
   delivery channel. Do not paste it into chat, ticketing systems, or any
   channel that logs message bodies.
5. Tell the user their employee ID out-of-band (e.g., verbally, or via a
   channel separate from the link) so they can complete step 3 of the User
   job aid below.

### 2.2 Approving an account recovery (lost all passkeys)

Use this when a pilot user reports they cannot sign in because they no longer
have access to **any** of their registered passkeys (lost/wiped device,
factory reset, etc.).

1. Verify the requester's identity through your normal help-desk / manager
   verification process **before** approving — this step, not the portal,
   is what prevents a social-engineered passkey takeover.
2. Call `POST /api/recovery-requests` with the same shape as onboarding:
   `entraUserId`, `personalEmail`, `employeeId`, and the
   `x-onboarding-approval-key` header (same key as onboarding — there is no
   separate recovery key).
3. Deliver the returned `recoveryUrl` the same way you would an onboarding
   link (known personal email, approved channel only).
4. **Understand what happens next is irreversible for the old passkeys**:
   once the user submits matching evidence, the portal revokes *every*
   existing passkey on that account before issuing the replacement TAP. Do
   not approve a recovery request unless you're confident the user genuinely
   needs it — there's no "undo" for the revoked methods.

### 2.3 Common Manager mistakes to avoid

- Submitting a UPN or display name instead of the immutable object ID —
  the API will reject unknown/mismatched users.
- Re-sending the same invitation/recovery URL after it's already been used —
  each is single-use; ask the Admin for the failure reason before generating
  a duplicate.
- Sharing the employee ID and the link in the same message — keeping them
  in separate channels is what makes the evidence check meaningful.

---

## 3. User job aid

### 3.1 Completing onboarding (first passkey)

1. Open the invitation link your manager sent you. It only works once.
2. On the page that opens, enter the **personal email** and **employee ID**
   your manager told you, exactly as given.
3. If they match, you'll see a **Temporary Access Pass (TAP)** displayed once.
   Copy it now — it will not be shown again and is not emailed to you.
4. Follow the on-screen link to **Microsoft Security info**
   (`https://mysignins.microsoft.com/security-info`), sign in using the TAP,
   and add a **passkey** when prompted.
5. Return to the portal and click **Confirm** — it checks with Microsoft that
   your new passkey was registered and finishes onboarding.
6. From now on, sign in with your passkey — no more passwords for this
   pilot account.

### 3.2 Completing account recovery (lost all passkeys)

Use this if you can no longer sign in because you don't have access to any of
your previously registered passkeys.

1. Ask your manager to submit a recovery request on your behalf (see the
   Manager job aid above) — you cannot start this yourself; it requires
   manager approval.
2. Open the recovery link your manager sends you. It only works once.
3. Enter the same **personal email** and **employee ID** your manager
   verified with you.
4. Once confirmed, **all of your old passkeys are removed** from your account
   automatically — this is expected and is what makes recovery safe if a lost
   device is the reason you're here.
5. You'll see a new TAP displayed once. Copy it now.
6. Go to **Microsoft Security info**, sign in with the TAP, and register a
   **replacement passkey**.
7. Return to the portal and click **Confirm** to finish. Your new passkey is
   now the only one on the account — set up any additional devices you use
   regularly the same way going forward.

### 3.3 If something goes wrong

| Symptom | Likely cause | What to do |
|---|---|---|
| "Invitation not found / expired / already used" | Link was already completed, or it's past its validity window | Ask your manager for a new invitation or recovery request — don't reuse an old link. |
| Email/employee ID don't match | Typo, or evidence given to you by your manager was wrong | Double-check with your manager before retrying — repeated mismatches lock the request. |
| TAP doesn't work at Security info | TAP is single-use and time-limited | Ask your manager to start a new request; do not request a second TAP from the same link. |
| Passkey registration doesn't get confirmed | Passkey wasn't actually registered on Security info, or you registered it before starting this flow | Re-visit Security info, confirm the passkey shows under "Sign-in methods," then click Confirm again. |
