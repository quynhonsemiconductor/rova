/*
 * Vietnamese edition, chapter 12-viet-backlog-item (US-119). Converted from the BA's static page
 * `public/guide/12-viet-backlog-item.html`.
 */
import {
  ChapterEyebrow,
  ChapterIntro,
  ChapterSummary,
  CheckUnderstanding,
  DocTable,
  Lead,
  Section,
  TemplateLabel,
  TroubleshootList,
  WritingTemplate,
} from '../../ui/parts'

export default function Chapter() {
  return (
    <>
      <ChapterIntro id="chapter-12">
        <div>
          <ChapterEyebrow>PHẦN 12 · AGILE GUIDELINE</ChapterEyebrow>
          <h2>Viết đủ rõ để cùng hiểu, ước lượng và kiểm thử</h2>
          <Lead>
            Một backlog item tốt mô tả <strong>vấn đề hoặc giá trị cần đạt</strong>, các điều kiện
            phải đúng và ranh giới công việc. Phần này hướng dẫn hai loại dùng thường xuyên trên
            Rova: <strong>User Story</strong> và <strong>Defect</strong>.
          </Lead>
        </div>
        <ChapterSummary aria-label="Sau phần này bạn sẽ làm được">
          <strong>Sau phần này, bạn sẽ làm được</strong>
          <ul>
            <li>Viết User Story có persona, mục tiêu và giá trị rõ ràng.</li>
            <li>Viết Acceptance Criteria bằng Given–When–Then.</li>
            <li>Ghi nhận Defect có thể tái hiện và xác minh.</li>
            <li>Phân biệt Defect với yêu cầu thay đổi.</li>
            <li>Tự kiểm tra item trước khi refinement.</li>
          </ul>
        </ChapterSummary>
      </ChapterIntro>
      <Section
        id="viet-user-story"
        number="12.1"
        title="Viết User Story"
        lead="User Story mô tả một giá trị nhỏ mà người dùng hoặc bên liên quan cần nhận được."
      >
        <p>
          Dùng User Story khi công việc tạo ra một hành vi hoặc kết quả có thể bàn giao và kiểm thử
          độc lập. Tiêu đề nên bắt đầu bằng động từ và nói rõ kết quả, ví dụ{' '}
          <strong>“Lọc Backlog theo Priority”</strong>. Tránh tiêu đề chung như “Cải thiện Backlog”
          hoặc “Làm màn hình filter”.
        </p>
        <WritingTemplate aria-label="Template User Story">
          <strong>Template User Story</strong>
          <p>
            <TemplateLabel>Title</TemplateLabel>[Động từ + đối tượng + kết quả cần đạt]
          </p>
          <p>
            <TemplateLabel>As a</TemplateLabel>[persona hoặc vai trò cụ thể]
          </p>
          <p>
            <TemplateLabel>I want to</TemplateLabel>[hành động hoặc outcome cần thực hiện]
          </p>
          <p>
            <TemplateLabel>So that</TemplateLabel>[giá trị nhận được hoặc vấn đề được giải quyết]
          </p>
          <p>
            <TemplateLabel>Business Rules</TemplateLabel>[quyền, phạm vi và giới hạn đã được xác
            nhận]
          </p>
          <p>
            <TemplateLabel>Acceptance Criteria</TemplateLabel>Given [bối cảnh] · When [hành động] ·
            Then [kết quả quan sát được]
          </p>
          <p>
            <TemplateLabel>Non-scope</TemplateLabel>[nội dung dễ bị hiểu nhầm nhưng không thuộc
            Story]
          </p>
          <p>
            <TemplateLabel>Open questions</TemplateLabel>[thông tin còn thiếu cần PO/BA xác nhận]
          </p>
        </WritingTemplate>
        <DocTable>
          <thead>
            <tr>
              <th>Thành phần</th>
              <th>Cách viết</th>
              <th>Cần tránh</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Persona</strong>
              </td>
              <td>Chọn người trực tiếp nhận giá trị hoặc chịu trách nhiệm cho kết quả.</td>
              <td>Dùng “user” cho mọi trường hợp mà không xác định vai trò.</td>
            </tr>
            <tr>
              <td>
                <strong>Goal</strong>
              </td>
              <td>Mô tả hành động hoặc outcome, đủ nhỏ để hoàn thành trong một Iteration.</td>
              <td>Liệt kê màn hình, API hoặc cách code thay cho nhu cầu.</td>
            </tr>
            <tr>
              <td>
                <strong>Value</strong>
              </td>
              <td>Nói rõ quyết định, thời gian hoặc rủi ro được cải thiện.</td>
              <td>Lặp lại nguyên văn phần I want to.</td>
            </tr>
            <tr>
              <td>
                <strong>Business Rules</strong>
              </td>
              <td>Ghi quyền, phạm vi, trạng thái và điều kiện đã có nguồn xác nhận.</td>
              <td>Tự thêm rule, SLA hoặc thông báo chưa được thống nhất.</td>
            </tr>
            <tr>
              <td>
                <strong>Acceptance Criteria</strong>
              </td>
              <td>Mỗi AC mô tả một tình huống và kết quả có thể quan sát.</td>
              <td>Viết như Test Case chi tiết hoặc mô tả cách triển khai.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          <strong>Acceptance Criteria không thay thế Test Case.</strong> AC xác định điều kiện
          nghiệm thu của Story; QA có thể phát triển thêm dữ liệu kiểm thử, biến thể và kiểm tra kỹ
          thuật.
        </p>
        <p>
          Ví dụ dưới đây dùng để minh họa cách điền template. Business Rules và AC phải được PO/BA
          xác nhận trước khi tạo Story thật.
        </p>
        <WritingTemplate aria-label="Ví dụ User Story trên Rova">
          <strong>Ví dụ minh họa: Lọc Backlog theo Priority</strong>
          <p>
            <TemplateLabel>As a</TemplateLabel>Editor của Team Maintainer
          </p>
          <p>
            <TemplateLabel>I want to</TemplateLabel>lọc Backlog theo một hoặc nhiều Priority
          </p>
          <p>
            <TemplateLabel>So that</TemplateLabel>tôi có thể tập trung xử lý các Work Item quan
            trọng trong phạm vi được giao
          </p>
          <p>
            <TemplateLabel>Rule 1</TemplateLabel>Kết quả chỉ gồm Work Item thuộc Project và Team
            người dùng được phép xem.
          </p>
          <p>
            <TemplateLabel>Rule 2</TemplateLabel>Bỏ toàn bộ lựa chọn Priority sẽ đưa danh sách về
            trạng thái không lọc theo Priority.
          </p>
          <p>
            <TemplateLabel>AC 1</TemplateLabel>
            <strong>Given</strong> Backlog có Work Item ở nhiều Priority, <strong>When</strong>{' '}
            người dùng chọn High, <strong>Then</strong> danh sách chỉ hiển thị Work Item có Priority
            High trong phạm vi hiện tại.
          </p>
          <p>
            <TemplateLabel>AC 2</TemplateLabel>
            <strong>Given</strong> bộ lọc High đang áp dụng, <strong>When</strong> người dùng bỏ lựa
            chọn High, <strong>Then</strong> Backlog hiển thị lại mọi Priority trong phạm vi hiện
            tại.
          </p>
          <p>
            <TemplateLabel>Non-scope</TemplateLabel>Lưu bộ lọc thành view cá nhân và chia sẻ bộ lọc.
          </p>
        </WritingTemplate>
        <p>
          <strong>Kiểm tra theo INVEST trước khi refinement:</strong>
        </p>
        <TroubleshootList>
          <article>
            <span>I</span>
            <div>
              <strong>Independent</strong>
              <p>
                Có thể triển khai và nghiệm thu mà không phụ thuộc chặt vào nhiều Story chưa xác
                định.
              </p>
            </div>
          </article>
          <article>
            <span>N</span>
            <div>
              <strong>Negotiable</strong>
              <p>Nêu nhu cầu và ranh giới, vẫn cho phép Team trao đổi giải pháp.</p>
            </div>
          </article>
          <article>
            <span>V</span>
            <div>
              <strong>Valuable</strong>
              <p>Persona nhận được giá trị rõ ràng khi Story hoàn thành.</p>
            </div>
          </article>
          <article>
            <span>E</span>
            <div>
              <strong>Estimable</strong>
              <p>Team hiểu đủ scope, rule và dependency để ước lượng.</p>
            </div>
          </article>
          <article>
            <span>S</span>
            <div>
              <strong>Small</strong>
              <p>Đủ nhỏ để hoàn thành trong một Iteration; nếu không, tách theo luồng hoặc rule.</p>
            </div>
          </article>
          <article>
            <span>T</span>
            <div>
              <strong>Testable</strong>
              <p>AC có kết quả quan sát được và không phụ thuộc cảm nhận chủ quan.</p>
            </div>
          </article>
        </TroubleshootList>
      </Section>
      <Section
        id="viet-defect"
        number="12.2"
        title="Viết Defect"
        lead="Defect ghi lại sự khác biệt giữa hành vi thực tế và kết quả đã được mong đợi."
      >
        <p>
          Chỉ tạo Defect khi có bằng chứng hệ thống sai so với requirement, Acceptance Criteria hoặc
          hành vi đã được chấp thuận. Nếu người dùng muốn một khả năng chưa từng được yêu cầu, đó
          thường là User Story hoặc yêu cầu thay đổi.
        </p>
        <WritingTemplate aria-label="Template Defect">
          <strong>Template Defect</strong>
          <p>
            <TemplateLabel>Title</TemplateLabel>[Chức năng] – [hành vi sai] khi [điều kiện]
          </p>
          <p>
            <TemplateLabel>Context</TemplateLabel>Project, Team, màn hình, phiên bản hoặc môi trường
            xảy ra lỗi
          </p>
          <p>
            <TemplateLabel>Precondition</TemplateLabel>Dữ liệu, quyền và trạng thái cần có trước khi
            tái hiện
          </p>
          <p>
            <TemplateLabel>Steps</TemplateLabel>Các thao tác ngắn, theo đúng thứ tự và không gộp
            nhiều hành động
          </p>
          <p>
            <TemplateLabel>Actual</TemplateLabel>Kết quả thực tế quan sát được
          </p>
          <p>
            <TemplateLabel>Expected</TemplateLabel>Kết quả đúng theo rule hoặc AC đã xác nhận
          </p>
          <p>
            <TemplateLabel>Severity</TemplateLabel>Mức ảnh hưởng kỹ thuật hoặc nghiệp vụ
          </p>
          <p>
            <TemplateLabel>Priority</TemplateLabel>Thứ tự cần xử lý theo quyết định sản phẩm
          </p>
          <p>
            <TemplateLabel>Evidence</TemplateLabel>Ảnh, video, log, thời điểm và ID dữ liệu liên
            quan
          </p>
          <p>
            <TemplateLabel>Links</TemplateLabel>User Story, Feature hoặc Defect liên quan
          </p>
        </WritingTemplate>
        <DocTable>
          <thead>
            <tr>
              <th>Trường</th>
              <th>Tiêu chuẩn tối thiểu</th>
              <th>Ví dụ chưa đạt</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Title</strong>
              </td>
              <td>Nói được chức năng, hành vi sai và điều kiện chính.</td>
              <td>“Filter bị lỗi”, “Không chạy”, “Bug Backlog”.</td>
            </tr>
            <tr>
              <td>
                <strong>Steps</strong>
              </td>
              <td>Người khác có thể lặp lại trên cùng dữ liệu và quyền.</td>
              <td>“Vào Backlog rồi thử filter”.</td>
            </tr>
            <tr>
              <td>
                <strong>Actual</strong>
              </td>
              <td>Mô tả đúng điều nhìn thấy, gồm giá trị hoặc thông báo nếu có.</td>
              <td>“Kết quả sai”.</td>
            </tr>
            <tr>
              <td>
                <strong>Expected</strong>
              </td>
              <td>Gắn với rule hoặc AC đã xác nhận.</td>
              <td>Đề xuất một tính năng mới chưa nằm trong requirement.</td>
            </tr>
            <tr>
              <td>
                <strong>Evidence</strong>
              </td>
              <td>Cho biết thời điểm, phạm vi và dữ liệu đủ để truy vết.</td>
              <td>Ảnh không thấy URL, Project, Team hoặc trạng thái liên quan.</td>
            </tr>
          </tbody>
        </DocTable>
        <p>
          Defect dưới đây minh họa cách ghi nhận. Chỉ tạo item thật sau khi đã tái hiện và có nguồn
          xác nhận Expected.
        </p>
        <WritingTemplate aria-label="Ví dụ Defect trên Rova">
          <strong>Ví dụ minh họa: Backlog – bộ lọc High vẫn hiển thị item Medium</strong>
          <p>
            <TemplateLabel>Context</TemplateLabel>Rova web · Project ROVA · Team Maintainer · trang
            Backlog
          </p>
          <p>
            <TemplateLabel>Precondition</TemplateLabel>Tài khoản có quyền xem Team; Backlog có ít
            nhất một item High và một item Medium.
          </p>
          <p>
            <TemplateLabel>Step 1</TemplateLabel>Mở Backlog và xác nhận đúng Project, Team.
          </p>
          <p>
            <TemplateLabel>Step 2</TemplateLabel>Mở Filters và chọn Priority = High.
          </p>
          <p>
            <TemplateLabel>Actual</TemplateLabel>Danh sách vẫn hiển thị Work Item có Priority
            Medium.
          </p>
          <p>
            <TemplateLabel>Expected</TemplateLabel>Danh sách chỉ hiển thị Work Item có Priority High
            trong phạm vi hiện tại.
          </p>
          <p>
            <TemplateLabel>Evidence</TemplateLabel>Ảnh toàn màn hình có context selector, filter
            High và dòng Medium; kèm thời điểm và Work Item ID.
          </p>
          <p>
            <TemplateLabel>Links</TemplateLabel>User Story “Lọc Backlog theo Priority”, AC 1.
          </p>
        </WritingTemplate>
        <p>
          <strong>Severity và Priority không phải một.</strong> Severity mô tả mức ảnh hưởng;
          Priority là quyết định xử lý sớm hay muộn. Một lỗi giao diện nhẹ vẫn có thể có Priority
          cao nếu nằm trên luồng demo quan trọng.
        </p>
        <TroubleshootList>
          <article>
            <span>01</span>
            <div>
              <strong>Không tái hiện được</strong>
              <p>
                Bổ sung quyền, Project, Team, dữ liệu mẫu, trình duyệt, thời điểm và tần suất xảy
                ra.
              </p>
            </div>
          </article>
          <article>
            <span>02</span>
            <div>
              <strong>Expected chưa có nguồn</strong>
              <p>
                Liên kết requirement hoặc AC. Nếu chưa thống nhất hành vi đúng, hỏi PO/BA trước khi
                kết luận là Defect.
              </p>
            </div>
          </article>
          <article>
            <span>03</span>
            <div>
              <strong>Một Defect chứa nhiều lỗi</strong>
              <p>Tách theo nguyên nhân hoặc kết quả có thể sửa và xác minh độc lập.</p>
            </div>
          </article>
          <article>
            <span>05</span>
            <div>
              <strong>Chỉ có ảnh chụp</strong>
              <p>Ảnh là bằng chứng, không thay thế Steps, Actual và Expected.</p>
            </div>
          </article>
        </TroubleshootList>
      </Section>
      <CheckUnderstanding>
        <strong>Tự kiểm tra trước khi đưa item vào refinement</strong>
        <ul>
          <li>User Story đã nói rõ persona, goal và value chưa?</li>
          <li>Mỗi Acceptance Criteria có một kết quả quan sát được chưa?</li>
          <li>Defect có đủ Context, Steps, Actual và Expected chưa?</li>
          <li>Expected đã có nguồn, hay đây thực chất là yêu cầu mới?</li>
        </ul>
      </CheckUnderstanding>
    </>
  )
}
