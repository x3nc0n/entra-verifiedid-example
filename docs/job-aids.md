# Job Aids

Practical, step-by-step guidance for the three roles in the canonical self-service
Verified ID onboarding flow: the **Admin**, the **Manager**, and the **Employee**.

---

## 1. Admin job aid

### 1.1 One-time setup

1. Set `PILOT_GROUP_ID` to the dedicated onboarding group.
2. Set `V2_ADMIN_GROUP_ID` to the immutable security group object ID assigned
   to the portal administrator app role and `V2_USERS_GROUP_ID` to the immutable
   security group object ID assigned to the user app role and used for tokenless
   bootstrap eligibility. For the Spaid pilot tenant those deployment values are
   JustJohn-SG
   `80334aae-af17-4a5a-9bca-046c0df39c15` and NativeUsers-SG
   `914a7e6f-dcc2-438a-bc02-d58d2eb5e87a`; keep them in deployment
   configuration rather than hardcoding names.
3. Define app roles on the manager OIDC app registration with stable IDs and
   `allowedMemberTypes: ['User']`: `VerifiedId.Onboarding.Admin` and
   `VerifiedId.Onboarding.User`. Assign JustJohn-SG to Admin and NativeUsers-SG
   to User through **Enterprise applications** -> the manager OIDC app ->
   **Users and groups** -> **Add user/group** -> select group -> select app
   role. Group assignment requires the appropriate Entra edition; nested groups
   do not cascade into the emitted `roles` claim.
4. Configure `ONBOARDING_STATE_BACKEND=azure-table` and grant the runtime
   identity `Storage Table Data Contributor` on the session and v2 request
   tables.
5. Configure the dedicated manager OIDC application and the exact
   `V2_MANAGER_OIDC_REDIRECT_URI`.
6. Configure the dedicated v2 Verified ID contract values:
   `V2_VERIFIED_ID_AUTHORITY`, `V2_VERIFIED_ID_MANIFEST_URL`,
   `V2_VERIFIED_ID_CREDENTIAL_TYPE`, `V2_VERIFIED_ID_OBJECT_ID_CLAIM`,
   `V2_VERIFIED_ID_EMPLOYEE_ID_CLAIM`, `V2_VERIFIED_ID_LINKED_DOMAIN`, and
   `V2_VERIFIED_ID_CALLBACK_API_KEY`.
7. Provide `SESSION_SECRET`, `V2_TRANSIENT_PROTECTION_KEY`, and
   `V2_MANAGER_OIDC_CLIENT_SECRET` as secure secrets.
8. Grant the runtime identity the Graph roles used by this flow:
   `User.Read.All`, `GroupMember.Read.All`,
   `UserAuthMethod-TAP.ReadWrite.All`, and
   `UserAuthMethod-Passkey.Read.All`.
9. Configure ACS Email when manager notifications should be sent live.

### 1.2 Ongoing responsibilities

| Task | How |
|---|---|
| Rotate app secrets | Rotate the Key Vault-backed secrets and redeploy. |
| Add or remove pilot users | Update membership in the dedicated pilot group in Entra. |
| Authorize portal admins | Maintain direct members of the configured admin security group assigned to the Admin app role. This is a manual Entra Enterprise App assignment step, not a GitHub Actions task. |
| Authorize users/managers | Maintain direct members of the configured users security group assigned to the User app role; Graph manager relationships still define direct and skip-level scope. |
| Investigate a stuck request | Use the scoped admin reset endpoint with a request kind, request ID, current ETag, action, and reason; the raw approval token, PIN, and TAP are not logged. |
| Validate manager sign-in | Confirm the manager OIDC app registration still matches `/auth/manager/callback`. |

### 1.3 Never do this

- Never capture the `#token=...` fragment from a manager approval link in logs,
  analytics, screenshots, or chat transcripts.
- Never point live traffic at `DEMO_MODE=true`.
- Never grant broader Graph app roles than the flow requires without review.

---

## 2. Manager job aid

### 2.1 Approving onboarding

1. Confirm the employee should be onboarded and is in scope for the pilot.
2. Wait for the employee to submit the onboarding request in the portal.
3. Open the approval link sent to your mailbox.
4. Complete manager sign-in with your tenant account.
5. Review the employee name and UPN shown on the approval page.
6. Choose **Approve** or **Reject**.

### 2.2 Never do this

- Never forward the approval link outside the intended manager channel.
- Never copy the approval URL into systems that log the full fragment.
- Never approve a request when the displayed employee does not match the person
  you expect.

---

## 3. Employee job aid

### 3.1 Completing onboarding

1. Open the portal and submit your tenant UPN and employee ID.
2. Wait for your current Entra manager to receive and approve the request.
3. Return to the status page and request your Verified ID.
4. Complete issuance in Microsoft Authenticator.
5. Present the issued credential back to the portal.
6. Copy the one-time TAP when it appears.
7. Open Microsoft Security info, sign in with the TAP, and register a passkey.
8. Return to the portal and confirm the new passkey.

### 3.2 Troubleshooting

| Symptom | Meaning | Action |
|---|---|---|
| Status stays at manager approval pending | The manager has not decided yet, or notification delivery failed. | Confirm your manager received the link; if needed, restart the request. |
| Approval link is invalid or expired | The manager token was already used or timed out. | Submit a new onboarding request. |
| Verified ID request fails | Issuance or presentation could not be started. | Retry from the status page; if it persists, contact the admin. |
| No new passkey is found | Graph does not yet see the new FIDO2 method. | Finish passkey setup in Security info, wait a moment, then confirm again. |
