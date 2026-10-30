/*
 * Vietnamese edition, chapter 04-testing (US-119). Converted from the BA's static page
 * `public/guide/04-testing.html`.
 */
import {
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  DocTable,
  InstructionList,
  Lead,
  Section,
  TemplateLabel,
  TroubleshootList,
  WritingTemplate,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-04">
        <div>
          <ChapterEyebrow>PHẦN 04 · TESTING</ChapterEyebrow>
          <h2>Tạo Test Case và ghi nhận kết quả kiểm thử</h2>
          <Lead>
            <strong>Test Case</strong> mô tả điều cần kiểm tra cho một User Story hoặc Defect.{' '}
            <strong>Test Result</strong> ghi lại kết quả của từng lần chạy trên một Build cụ thể.
          </Lead>
        </div>
        <ChapterSummary aria-label="Sau phần này bạn sẽ làm được">
          <strong>Sau phần này, bạn sẽ làm được</strong>
          <ul>
            <li>Mở danh sách Test Case của US/DE.</li>
            <li>Tạo và hoàn thiện một Test Case.</li>
            <li>Ghi Test Result cho từng lần chạy.</li>
            <li>Đọc Last Verdict, Last Run và lịch sử.</li>
            <li>Quản lý Test Case Type theo Project.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="hieu-luong-testing"
        number="04.1"
        title="Hiểu luồng Testing"
        lead="Testing bắt đầu từ Work Item cần xác minh và giữ riêng nội dung kiểm thử với kết quả của từng lần chạy."
      >
        <WritingTemplate aria-label="Quan hệ giữa Work Item, Test Case và Test Result">
          <strong>User Story hoặc Defect → Test Case → Test Result</strong>
          <p>
            <TemplateLabel>Work Item</TemplateLabel>Nêu nhu cầu hoặc lỗi cần xác minh. Một US/DE có
            thể có nhiều Test Case.
          </p>
          <p>
            <TemplateLabel>Test Case</TemplateLabel>Mô tả mục tiêu, điều kiện, dữ liệu đầu vào và
            kết quả mong đợi. Test Case luôn liên kết với một Work Product hiện tại.
          </p>
          <p>
            <TemplateLabel>Test Result</TemplateLabel>Ghi Build, ngày chạy, Verdict, thời lượng và
            Tester của một lần thực thi. Một Test Case có thể có nhiều Result.
          </p>
        </WritingTemplate>
        <p>
          <strong>Không ghi đè Test Case để lưu kết quả chạy.</strong> Khi chạy lại trên Build khác,
          hãy thêm Result mới để giữ được lịch sử Pass, Fail hoặc Blocked trước đó.
        </p>
      </Section>
      <Section
        id="mo-test-cases"
        number="04.2"
        title="Mở Test Cases của Work Item"
        lead="Test Cases nằm trong trang chi tiết của User Story hoặc Defect, ngay sau tab Tasks."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở User Story hoặc Defect</strong>
              <p>Từ Backlog, Iteration Status hoặc Quality, chọn ID của Work Item cần kiểm thử.</p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Chọn tab Test Cases</strong>
              <p>Con số trên tab cho biết tổng Test Case đang liên kết với Work Item.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Đọc danh sách</strong>
              <p>
                Dùng Search, Filters và Show Fields khi danh sách dài. Chọn ID Test Case để mở chi
                tiết.
              </p>
            </div>
          </li>
        </InstructionList>
        <DocTable>
          <thead>
            <tr>
              <th>Cột</th>
              <th>Ý nghĩa</th>
              <th>Cách dùng</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Name</strong>
              </td>
              <td>Mục tiêu kiểm thử ngắn gọn.</td>
              <td>Đọc Name trước để tránh tạo Test Case trùng mục tiêu.</td>
            </tr>
            <tr>
              <td>
                <strong>Type / Method</strong>
              </td>
              <td>Loại kiểm thử và cách chạy Manual hoặc Automated.</td>
              <td>Dùng để tìm và phân nhóm Test Case phù hợp.</td>
            </tr>
            <tr>
              <td>
                <strong>Priority / Owner</strong>
              </td>
              <td>Mức ưu tiên và người chịu trách nhiệm.</td>
              <td>Kiểm tra trước khi bắt đầu thực thi.</td>
            </tr>
            <tr>
              <td>
                <strong>Last Verdict</strong>
              </td>
              <td>Verdict của Result mới nhất.</td>
              <td>Cho biết trạng thái kiểm thử gần nhất, không thay thế lịch sử Result.</td>
            </tr>
            <tr>
              <td>
                <strong>Last Run</strong>
              </td>
              <td>Ngày của Result mới nhất.</td>
              <td>Dùng để nhận biết Test Case đã được chạy gần đây hay chưa.</td>
            </tr>
          </tbody>
        </DocTable>
      </Section>
      <Section
        id="tao-test-case"
        number="04.3"
        title="Tạo Test Case"
        lead="Tạo Test Case từ chính US/DE để Rova tự liên kết đúng Work Product, Project và Team."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Chọn Add New</strong>
              <p>
                Trong tab <b>Test Cases</b>, chọn <b>Add New</b> để mở form Create Test Case.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Nhập Name</strong>
              <p>
                Viết một mục tiêu kiểm thử rõ ràng, ngắn gọn. Nút Create bị khóa khi Name còn trống.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Kiểm tra thông tin phân loại</strong>
              <p>
                Chọn Type, Method, Priority, Owner và Assigned To phù hợp. Project được lấy từ Work
                Item hiện tại.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Tạo và mở chi tiết</strong>
              <p>
                Chọn <b>Create</b>. Test Case mới được liên kết với US/DE và bắt đầu ở trạng thái
                chưa có kết quả chạy.
              </p>
            </div>
          </li>
        </InstructionList>
        <DocTable>
          <thead>
            <tr>
              <th>Trường</th>
              <th>Cách nhập</th>
              <th>Lưu ý</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Name</strong>
              </td>
              <td>Nêu hành vi hoặc điều kiện chính cần xác minh.</td>
              <td>Bắt buộc; mỗi Test Case nên có một mục tiêu chính.</td>
            </tr>
            <tr>
              <td>
                <strong>Type</strong>
              </td>
              <td>Chọn Type của Project, ví dụ Acceptance, Functional hoặc Regression.</td>
              <td>Danh sách Type được cấu hình theo từng Project.</td>
            </tr>
            <tr>
              <td>
                <strong>Method</strong>
              </td>
              <td>Chọn Manual hoặc Automated.</td>
              <td>Phản ánh cách Test Case được thực thi.</td>
            </tr>
            <tr>
              <td>
                <strong>Priority</strong>
              </td>
              <td>Chọn Low, Normal, High hoặc Urgent.</td>
              <td>Priority thể hiện thứ tự cần kiểm thử.</td>
            </tr>
            <tr>
              <td>
                <strong>Owner</strong>
              </td>
              <td>Chọn người chịu trách nhiệm cho Test Case.</td>
              <td>Khác với Assigned To.</td>
            </tr>
            <tr>
              <td>
                <strong>Assigned To</strong>
              </td>
              <td>Chọn người đang được giao thực hiện hoặc để Unassigned.</td>
              <td>Có thể thay đổi sau trên Test Case Detail.</td>
            </tr>
          </tbody>
        </DocTable>
      </Section>
      <Section
        id="hoan-thien-test-case"
        number="04.4"
        title="Hoàn thiện nội dung Test Case"
        lead="Điền đủ điều kiện, đầu vào và kết quả mong đợi để người khác có thể chạy lại mà không cần hỏi thêm."
      >
        <DocTable>
          <thead>
            <tr>
              <th>Nội dung</th>
              <th>Nên viết</th>
              <th>Cần tránh</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Description</strong>
              </td>
              <td>Tóm tắt phạm vi và hành vi cần kiểm tra.</td>
              <td>Lặp lại Name mà không bổ sung ngữ cảnh.</td>
            </tr>
            <tr>
              <td>
                <strong>Objective</strong>
              </td>
              <td>Nêu mục tiêu hoặc Acceptance Criteria được xác minh.</td>
              <td>Gộp nhiều mục tiêu không liên quan.</td>
            </tr>
            <tr>
              <td>
                <strong>Preconditions</strong>
              </td>
              <td>Ghi quyền, dữ liệu, Project, Team và trạng thái cần có trước khi chạy.</td>
              <td>Dùng điều kiện ngầm mà Tester không biết.</td>
            </tr>
            <tr>
              <td>
                <strong>Input</strong>
              </td>
              <td>Ghi thao tác và dữ liệu kiểm thử theo đúng thứ tự.</td>
              <td>Viết chung chung như “thử chức năng”.</td>
            </tr>
            <tr>
              <td>
                <strong>Expected Result</strong>
              </td>
              <td>Nêu kết quả quan sát được và có thể so sánh.</td>
              <td>Dùng từ mơ hồ như “hoạt động đúng”.</td>
            </tr>
            <tr>
              <td>
                <strong>Postconditions</strong>
              </td>
              <td>Nêu dữ liệu hoặc trạng thái còn lại sau khi chạy.</td>
              <td>Bỏ qua dữ liệu cần dọn hoặc khôi phục.</td>
            </tr>
            <tr>
              <td>
                <strong>Notes / Attachments</strong>
              </td>
              <td>Bổ sung hướng dẫn, file hoặc bằng chứng cần thiết.</td>
              <td>Đưa kết luận Pass/Fail vào đây thay cho Result.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          <strong>Rova không có danh sách Test Steps tách riêng.</strong> Hãy dùng cặp <b>Input</b>{' '}
          và <b>Expected Result</b> để mô tả bước kiểm thử và kết quả cần quan sát.
        </p>
      </Section>
      <Section
        id="ghi-test-result"
        number="04.5"
        title="Ghi Test Result"
        lead="Mỗi Result đại diện cho một lần chạy Test Case trên một Build và không thay thế các Result trước đó."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở Test Case Detail</strong>
              <p>
                Chọn tab <b>Results</b>; số trên tab là tổng Result đã lưu.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Chọn Add Result</strong>
              <p>Rova tự điền Test Case và Work Product hiện tại dưới dạng chỉ đọc.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Nhập thông tin lần chạy</strong>
              <p>Nhập Build, Date, Verdict, Duration, Tester và Notes nếu cần.</p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Lưu Result</strong>
              <p>
                Chọn <b>Save</b>. Result mới được thêm vào lịch sử và không xóa kết quả cũ.
              </p>
            </div>
          </li>
          <li>
            <span>5</span>
            <div>
              <strong>Kiểm tra roll-up</strong>
              <p>Quay lại Test Case và xác nhận Last Verdict, Last Run phản ánh Result mới nhất.</p>
            </div>
          </li>
        </InstructionList>
        <DocTable>
          <thead>
            <tr>
              <th>Trường</th>
              <th>Cách nhập</th>
              <th>Lưu ý</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Build</strong>
              </td>
              <td>Tên hoặc mã bản được kiểm thử.</td>
              <td>Bắt buộc; dùng quy ước thống nhất để dễ truy vết.</td>
            </tr>
            <tr>
              <td>
                <strong>Date</strong>
              </td>
              <td>Ngày thực tế thực hiện kiểm thử.</td>
              <td>Ảnh hưởng đến Result được xem là mới nhất.</td>
            </tr>
            <tr>
              <td>
                <strong>Verdict</strong>
              </td>
              <td>Chọn Pass, Fail, Blocked, Error hoặc Inconclusive.</td>
              <td>Chỉ chọn Pass khi đã chạy và có đủ bằng chứng.</td>
            </tr>
            <tr>
              <td>
                <strong>Duration</strong>
              </td>
              <td>Số phút thực hiện; dùng số từ 0 trở lên.</td>
              <td>Không nhập giờ vào trường phút.</td>
            </tr>
            <tr>
              <td>
                <strong>Tester</strong>
              </td>
              <td>Người thực hiện lần chạy.</td>
              <td>Khác Owner và Assigned To của Test Case.</td>
            </tr>
            <tr>
              <td>
                <strong>Notes</strong>
              </td>
              <td>Ghi dữ liệu, môi trường, blocker hoặc bằng chứng bổ sung.</td>
              <td>Không dùng Notes thay cho Build hoặc Verdict.</td>
            </tr>
          </tbody>
        </DocTable>
      </Section>
      <Section
        id="doc-ket-qua-testing"
        number="04.6"
        title="Đọc kết quả và lịch sử"
        lead="Đọc Last Verdict để biết kết quả gần nhất, sau đó mở Results khi cần hiểu toàn bộ lịch sử chạy."
      >
        <p>
          <strong>Last Verdict</strong> lấy Verdict của Result mới nhất. <strong>Last Run</strong>{' '}
          lấy ngày của Result đó. Nếu hai Result có cùng ngày, Rova dùng thời điểm tạo để xác định
          bản mới hơn.
        </p>
        <DocTable>
          <thead>
            <tr>
              <th>Khu vực</th>
              <th>Cho biết</th>
              <th>Khi nào dùng</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Test Cases list</strong>
              </td>
              <td>Last Verdict và Last Run của từng Test Case.</td>
              <td>Rà nhanh coverage và tình trạng gần nhất.</td>
            </tr>
            <tr>
              <td>
                <strong>Results list</strong>
              </td>
              <td>Build, Date, Work Product, Verdict, Duration và Tester của từng lần chạy.</td>
              <td>So sánh kết quả giữa nhiều Build hoặc lần chạy.</td>
            </tr>
            <tr>
              <td>
                <strong>Result Detail</strong>
              </td>
              <td>Thông tin và file đính kèm của một Result cụ thể.</td>
              <td>Điều tra Fail, Blocked, Error hoặc Inconclusive.</td>
            </tr>
            <tr>
              <td>
                <strong>Revision History</strong>
              </td>
              <td>Các thay đổi đã ghi nhận trên Test Case hoặc Result.</td>
              <td>Truy vết ai thay đổi dữ liệu và thay đổi gì.</td>
            </tr>
          </tbody>
        </DocTable>
      </Section>
      <Section
        id="quan-ly-test-case-type"
        number="04.7"
        title="Quản lý Test Case Type"
        lead="Workspace Admin quản lý danh sách Type riêng cho từng Project."
      >
        <InstructionList>
          <li>
            <span>1</span>
            <div>
              <strong>Mở Project</strong>
              <p>
                Vào <b>Settings → Workspaces & Projects</b>, chọn Project cần cấu hình và mở tab{' '}
                <b>Details</b>.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Tìm Test Case Types</strong>
              <p>
                Project mới có các Type mặc định: Acceptance, Functional, Regression, Performance và
                Usability.
              </p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Thêm Type</strong>
              <p>
                Chọn <b>Add New</b>, nhập tên không trùng trong Project rồi lưu.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Ngừng dùng Type</strong>
              <p>
                Chọn Remove và xác nhận. Type không còn xuất hiện khi tạo mới; Test Case cũ vẫn giữ
                giá trị lịch sử.
              </p>
            </div>
          </li>
        </InstructionList>
      </Section>
      <Section
        id="xu-ly-testing"
        number="04.8"
        title="Xử lý tình huống thường gặp"
        lead="Kiểm tra Work Product, dữ liệu bắt buộc và Result mới nhất trước khi tạo lại bản ghi."
      >
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Không thấy tab Test Cases</strong>
              <p>
                Xác nhận bạn đang mở User Story hoặc Defect Detail và có quyền xem Work Item trong
                Project/Team đó.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Create đang bị khóa</strong>
              <p>Nhập Name và kiểm tra Type, Method, Priority, Owner, Assigned To trước khi tạo.</p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Test Case không đúng Work Product</strong>
              <p>
                Quay lại US/DE đúng rồi tạo từ tab Test Cases của chính Work Item đó; không tạo một
                bản khác để che lỗi liên kết.
              </p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Save Result đang bị khóa</strong>
              <p>Kiểm tra Build, Date và Tester. Duration không được nhỏ hơn 0.</p>
            </div>
          </article>
          <article>
            <span>06</span>
            <div>
              <strong>Last Verdict không như dự kiến</strong>
              <p>
                Mở danh sách Results và kiểm tra Date. Last Verdict lấy từ Result mới nhất, không
                phải Result vừa mở.
              </p>
            </div>
          </article>
          <article>
            <span>07</span>
            <div>
              <strong>Không thấy Type cần chọn</strong>
              <p>
                Nhờ Workspace Admin kiểm tra Test Case Types của đúng Project; Type có thể đã bị
                ngừng dùng.
              </p>
            </div>
          </article>
        </TroubleshootList>
        <CheckUnderstanding>
          <strong>Tự kiểm tra trước khi kết thúc</strong>
          <ul>
            <li>Test Case đã liên kết đúng User Story hoặc Defect chưa?</li>
            <li>Input và Expected Result đã đủ để người khác chạy lại chưa?</li>
            <li>Result có đúng Build, Date, Verdict và Tester chưa?</li>
            <li>Bạn đang đọc kết quả mới nhất hay một Result lịch sử?</li>
          </ul>
        </CheckUnderstanding>
      </Section>
    </>
  )
}
