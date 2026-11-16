/**
 * Synthetic SSIS snapshot in the upstream nav.json shape. The PII values are
 * deliberately distinctive so tests can prove the importer drops them:
 * nothing in this file is real data.
 */
export const SSIS_PII = {
  citizenshipNo: "99-88-77-66554",
  panNo: "987654321",
  dob: "1990-05-17",
  bankAccountNo: "555444333222111",
  boAccountNo: "1301999888777666",
  phone: "9812345678",
  email: "holder@secret.example",
  otp: "987123"
};

function purchaseRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    l_company_id: "001",
    Scheme_code: "001",
    ccode: "1000",
    REQUEST_NO: 1001,
    Bo_Account_No: SSIS_PII.boAccountNo,
    FName: "Test",
    LName: "Holder",
    Citizenship_No: SSIS_PII.citizenshipNo,
    PAN_No: SSIS_PII.panNo,
    DOB: SSIS_PII.dob,
    Bank_Account_No: SSIS_PII.bankAccountNo,
    P_Mobile_no: SSIS_PII.phone,
    Email_ID: SSIS_PII.email,
    OTP: SSIS_PII.otp,
    APPLY_DT: "2024-01-15",
    APPLY_UNIT: 100.25,
    AMOUNT: "1002.50",
    APPSTATUS: "VERIFIED",
    current_nav: 10.0,
    nav_date: "2024-01-15",
    SchemeName: "Siddhartha Systematic Investment Scheme",
    Is_SIP: true,
    ...overrides
  };
}

export function buildSsisPayload(): unknown {
  return [
    {
      unitPurchase: [
        purchaseRow({}),
        purchaseRow({
          REQUEST_NO: 1002,
          APPLY_DT: "2024-02-15",
          APPLY_UNIT: 50,
          AMOUNT: "510.00",
          current_nav: 10.2,
          nav_date: "2024-02-15"
        }),
        purchaseRow({
          REQUEST_NO: 1003,
          APPLY_DT: "2024-03-15",
          APPLY_UNIT: "25.5",
          AMOUNT: 260.1,
          current_nav: "10.20",
          nav_date: "2024-03-15",
          Is_SIP: null,
          SchemeName: null
        }),
        // Malformed: no REQUEST_NO.
        purchaseRow({ REQUEST_NO: null }),
        // Malformed: unparseable units.
        purchaseRow({ REQUEST_NO: 1004, APPLY_UNIT: "not-a-number" })
      ],
      statement: [
        {
          scheme_code: "001",
          ccode: "1000",
          SIP_Reg_No: "SIP0001",
          trans_no: "T1",
          installmentDate: "2024-01-15",
          dueDate: null,
          actionDate: "2024-01-16",
          Amount_cr: "1002.50",
          Amount_dr: "-",
          unit: "100.25",
          appnav: "10.00",
          payment: "E-Sewa",
          otherCharges: "5",
          sebon_fee: "2",
          BOID: SSIS_PII.boAccountNo,
          Name: "Test Holder"
        },
        {
          scheme_code: "001",
          ccode: "1000",
          SIP_Reg_No: "SIP0001",
          trans_no: "T2",
          installmentDate: "2024-02-15",
          dueDate: null,
          actionDate: "2024-02-16",
          Amount_cr: "0",
          Amount_dr: "510.00",
          unit: "",
          appnav: "",
          payment: null,
          otherCharges: "",
          sebon_fee: "",
          BOID: SSIS_PII.boAccountNo,
          Name: "Test Holder"
        },
        // Malformed: no trans_no.
        { trans_no: "", installmentDate: "2024-03-15", Amount_cr: "1", Amount_dr: "0" }
      ],
      navData: {
        IsSucess: true,
        ResponseData: [{ Scheme_code: "001", nav_date: "2024-03-20", nav_value: 11.5 }]
      },
      overallNav: [
        { eng_date: "2024-01-31", nep_date: "2080-10-17", nav: "10.10" },
        { eng_date: "2024-02-29", nep_date: "2080-11-17", nav: "10.40" },
        { eng_date: "2024-03-31", nep_date: "2080-12-17", nav: "11.00" },
        // Future point: must never become the "current" NAV.
        { eng_date: "2999-01-31", nep_date: "2081-01-01", nav: "99.99" }
      ]
    }
  ];
}
